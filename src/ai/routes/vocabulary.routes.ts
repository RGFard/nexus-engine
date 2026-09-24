import type { FastifyInstance } from "fastify";
import type { CustomVocabularyStore } from "../services/custom-vocabulary.store.js";
import type { CanonicalFieldsService } from "../services/canonical-fields.service.js";
import type { AcceptVocabularyRequest, AcceptVocabularyResult, VocabularyEntry } from "../models/vocabulary.types.js";
import { AiMappingError } from "../services/ai-mapping.service.js";
import { aiLog } from "../utils/ai-logger.js";

const log = aiLog("vocabulary-routes");

export interface VocabularyRouteDeps {
  vocabularyStore: CustomVocabularyStore;
  canonicalFields: CanonicalFieldsService;
}

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
      "VOCAB_SECRET is not set — POST /vocabulary/accept is registered but returns 404 on all requests. " +
      "Set VOCAB_SECRET to enable this internal endpoint.",
    );
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
      // Endpoint is dark when VOCAB_SECRET is unset — return 404 to avoid
      // leaking its existence to unauthenticated callers.
      if (!secret) {
        return reply.status(404).send({ error: "Not found" });
      }

      const provided = request.headers["x-vocabulary-secret"];
      if (!provided || provided !== secret) {
        log.warn({ ip: request.ip }, "Rejected /vocabulary/accept — bad or missing secret");
        return reply.status(401).send({ error: "Unauthorized" });
      }

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
