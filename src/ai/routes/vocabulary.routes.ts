import type { FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CustomVocabularyStore } from "../services/custom-vocabulary.store.js";
import type { LearnedVocabularyStore } from "../services/learned-vocabulary.store.js";
import type { CanonicalFieldsService } from "../services/canonical-fields.service.js";
import type { AcceptVocabularyRequest, AcceptVocabularyResult, VocabularyEntry } from "../models/vocabulary.types.js";
import { AiMappingError } from "../services/ai-mapping.service.js";
import { aiLog } from "../utils/ai-logger.js";

const log = aiLog("vocabulary-routes");

export interface VocabularyRouteDeps {
  vocabularyStore: CustomVocabularyStore;
  canonicalFields: CanonicalFieldsService;
  learnedVocabularyStore: LearnedVocabularyStore;
}

const errorSchema = { type: "object", properties: { error: { type: "string" } } } as const;

const pendingEntrySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sourceField: { type: "string" },
    targetField: { type: "string" },
    transformation: { type: "string" },
    confidence: { type: "number" },
    reasoning: { type: "string" },
    context: {
      type: "object",
      properties: {
        sourceSchemaId: { type: "string" },
        targetSchemaId: { type: "string" },
        clientId: { type: "string" },
      },
    },
    firstSeenAt: { type: "string" },
    lastSeenAt: { type: "string" },
    seenCount: { type: "integer" },
    sourceSystem: {
      type: ["string", "null"],
      description: "Best-guess carrier/ERP format this field came from (DHL, FedEx, UPS, SAP/ERP, ShipStation), or null if unrecognized. A pattern match on the field path, not a fact supplied by the caller.",
    },
  },
} as const;

const learnedEntrySchema = {
  type: "object",
  properties: {
    inputField: { type: "string" },
    canonicalField: { type: "string" },
    transformation: { type: "string" },
    acceptedAt: { type: "string" },
  },
} as const;

const reconsiderEntrySchema = {
  type: "object",
  properties: {
    ...pendingEntrySchema.properties,
    reason: { type: "string" },
    rejectedAt: { type: "string" },
    selectedTarget: {
      type: ["string", "null"],
      description: "What the global vocabulary currently maps this source field to instead, or null if nothing does.",
    },
  },
} as const;

const secretHeaders = {
  type: "object",
  properties: { "x-vocabulary-secret": { type: "string" } },
} as const;

/**
 * Registers POST /vocabulary/accept.
 *
 * This endpoint mutates persistent per-tenant state, so it is NOT public.
 * It requires a shared secret in the X-Vocabulary-Secret header, set via the
 * VOCAB_SECRET environment variable.
 *
 * If VOCAB_SECRET is unset the route is still registered but every request
 * returns 404 — this prevents accidental exposure in environments where the
 * variable was never configured.
 *
 * clientId is taken from the request body. A proper auth layer (JWT/API-key)
 * should derive clientId from the authenticated principal instead; this
 * shared-secret approach is an interim measure until auth exists.
 */
export async function registerVocabularyRoutes(
  app: FastifyInstance,
  deps: VocabularyRouteDeps,
): Promise<void> {
  const secret = process.env.VOCAB_SECRET;

  if (!secret) {
    log.warn(
      "VOCAB_SECRET is not set — /vocabulary/* routes are registered but return 404 on all requests. " +
      "Set VOCAB_SECRET to enable these internal endpoints.",
    );
  }
  if (!process.env.LEARNED_VOCAB_DIR) {
    log.warn(
      "LEARNED_VOCAB_DIR is not set — pending and accepted global vocabulary are kept in memory " +
      "and lost on restart.",
    );
  }

  /**
   * Shared-secret gate for all /vocabulary/* routes. Sends the error reply and
   * returns false when the request may not proceed. Routes are dark (404) when
   * VOCAB_SECRET is unset, to avoid leaking their existence.
   */
  function authorize(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!secret) {
      reply.status(404).send({ error: "Not found" });
      return false;
    }
    const provided = request.headers["x-vocabulary-secret"];
    if (!provided || provided !== secret) {
      log.warn({ ip: request.ip, url: request.url }, "Rejected vocabulary request — bad or missing secret");
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  app.post<{ Body: AcceptVocabularyRequest }>(
    "/vocabulary/accept",
    {
      schema: {
        tags: ["vocabulary"],
        summary: "Accept and persist field→canonical mappings for a client (internal)",
        description:
          "Internal endpoint — requires X-Vocabulary-Secret header matching VOCAB_SECRET env var. " +
          "Stores explicit input→canonical field mappings for a specific client. " +
          "Accepted mappings resolve at confidence 1.0 on subsequent /ai/normalize calls " +
          "(pass the same clientId in options) and never reach the AI path again. " +
          "Only the canonical target is validated — input field names are arbitrary by design.",
        headers: {
          type: "object",
          properties: {
            "x-vocabulary-secret": { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["clientId", "acceptedMappings"],
          properties: {
            clientId: {
              type: "string",
              minLength: 1,
              description: "Tenant / client identifier",
            },
            acceptedMappings: {
              type: "array",
              items: {
                type: "object",
                required: ["inputField", "canonicalField"],
                properties: {
                  inputField: {
                    type: "string",
                    description: "Arbitrary source field name — never validated or rejected",
                  },
                  canonicalField: {
                    type: "string",
                    description: "Target canonical path (JSON Pointer, e.g. /packages[]/weight/value)",
                  },
                },
              },
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              accepted: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    inputField: { type: "string" },
                    canonicalField: { type: "string" },
                  },
                },
              },
              rejected: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    inputField: { type: "string" },
                    canonicalField: { type: "string" },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
          401: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          400: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      if (!authorize(request, reply)) return reply;

      try {
        const result = await acceptVocabulary(request.body, deps.vocabularyStore, deps.canonicalFields);
        const code =
          result.accepted.length === 0 && result.rejected.length > 0 ? 400 : 200;
        return reply.status(code).send(result);
      } catch (err) {
        if (err instanceof AiMappingError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        log.error({ err }, "Unexpected error in /vocabulary/accept");
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // ── Global learned vocabulary: review queue for AI-fallback mappings ────────

  app.get(
    "/vocabulary/pending",
    {
      schema: {
        tags: ["vocabulary"],
        summary: "List AI-fallback mappings awaiting accept/reject (internal)",
        description:
          "Every mapping the AI fallback produced (not heuristic, not vocabulary) is queued here. " +
          "Accepting adds it to the global custom vocabulary so the field never needs AI again.",
        headers: secretHeaders,
        response: {
          200: {
            type: "object",
            properties: { pending: { type: "array", items: pendingEntrySchema } },
          },
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!authorize(request, reply)) return reply;
      return { pending: await deps.learnedVocabularyStore.listPending() };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/vocabulary/pending/:id/accept",
    {
      schema: {
        tags: ["vocabulary"],
        summary: "Accept a pending mapping into the global custom vocabulary (internal)",
        headers: secretHeaders,
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: { accepted: learnedEntrySchema },
          },
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!authorize(request, reply)) return reply;
      const accepted = await deps.learnedVocabularyStore.acceptPending(request.params.id);
      if (!accepted) {
        return reply.status(404).send({ error: `Pending entry '${request.params.id}' not found` });
      }
      log.info({ id: request.params.id, ...accepted }, "Pending vocabulary accepted into global list");
      return { accepted };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/vocabulary/pending/:id/reject",
    {
      schema: {
        tags: ["vocabulary"],
        summary: "Reject a pending mapping into the reconsider list (internal)",
        description:
          "Moves the entry to the reconsider list instead of dropping it, so a deliberate " +
          "'not this, for now' decision is kept for a future look (GET /vocabulary/reconsider). " +
          "An optional 'reason' in the body is stored with it.",
        headers: secretHeaders,
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        // No body schema: fastify/ajv rejects a request sent with no body at all against a
        // required `type: "object"` body schema, and reason is optional anyway — read it
        // loosely in the handler instead of declaring (and enforcing) a body shape here.
        response: {
          200: { type: "object", properties: { rejected: { type: "string" } } },
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!authorize(request, reply)) return reply;
      const reason = (request.body as { reason?: string } | undefined)?.reason;
      const removed = await deps.learnedVocabularyStore.rejectPending(request.params.id, reason);
      if (!removed) {
        return reply.status(404).send({ error: `Pending entry '${request.params.id}' not found` });
      }
      log.info({ id: request.params.id, reason: removed.reason }, "Pending vocabulary rejected to reconsider list");
      return { rejected: request.params.id };
    },
  );

  app.get(
    "/vocabulary/reconsider",
    {
      schema: {
        tags: ["vocabulary"],
        summary: "List rejected mappings held for future reconsideration (internal)",
        description:
          "Entries rejected from the pending queue land here instead of vanishing, so a deliberate " +
          "'not this, for now' call stays visible instead of silently being re-proposed from scratch.",
        headers: secretHeaders,
        response: {
          200: {
            type: "object",
            properties: { reconsider: { type: "array", items: reconsiderEntrySchema } },
          },
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!authorize(request, reply)) return reply;
      return { reconsider: await deps.learnedVocabularyStore.listReconsider() };
    },
  );
}

async function acceptVocabulary(
  req: AcceptVocabularyRequest,
  store: CustomVocabularyStore,
  canonical: CanonicalFieldsService,
): Promise<AcceptVocabularyResult> {
  if (!req.clientId) throw new AiMappingError("clientId is required", 400);
  if (!Array.isArray(req.acceptedMappings)) {
    throw new AiMappingError("acceptedMappings must be an array", 400);
  }

  const valid: VocabularyEntry[] = [];
  const rejected: AcceptVocabularyResult["rejected"] = [];

  for (const m of req.acceptedMappings) {
    if (!m?.inputField || !m?.canonicalField) {
      rejected.push({
        inputField: m?.inputField ?? "",
        canonicalField: m?.canonicalField ?? "",
        reason: "inputField and canonicalField are both required",
      });
      continue;
    }
    // Validate canonical TARGET only. Input field names are arbitrary — never reject them.
    if (!canonical.isCanonicalField(m.canonicalField)) {
      rejected.push({
        inputField: m.inputField,
        canonicalField: m.canonicalField,
        reason: `'${m.canonicalField}' is not a known canonical field`,
      });
      continue;
    }
    valid.push({ inputField: m.inputField, canonicalField: m.canonicalField });
  }

  const accepted = valid.length > 0 ? await store.accept(req.clientId, valid) : [];

  log.info(
    { clientId: req.clientId, accepted: accepted.length, rejected: rejected.length },
    "Vocabulary accept completed",
  );

  return { accepted, rejected };
}
