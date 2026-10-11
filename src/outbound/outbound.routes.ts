import type { FastifyInstance } from "fastify";
import { PathError } from "../ai/services/transformation-executor.service.js";
import { createChildLogger } from "../utils/logger.js";
import type { OutboundTargetRegistry } from "./outbound-target.registry.js";
import { OutboundError, type OutboundService } from "./outbound.service.js";
import type { OutboundTransformRequest } from "./outbound.types.js";

const mappingSchema = {
  type: "object",
  properties: {
    sourceField: { type: "string" },
    targetField: { type: "string" },
    confidence: { type: "number" },
    transformation: { type: "string" },
    reasoning: { type: "string" },
  },
} as const;

const errorListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      instancePath: { type: "string" },
      message: { type: "string" },
    },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    details: errorListSchema,
  },
} as const;

export interface OutboundRouteDeps {
  outboundService: OutboundService;
  outboundTargets: OutboundTargetRegistry;
}

export async function registerOutboundRoutes(
  app: FastifyInstance,
  deps: OutboundRouteDeps,
): Promise<void> {
  const log = createChildLogger({ component: "outbound-routes" });

  app.get(
    "/outbound/targets",
    {
      schema: {
        tags: ["outbound"],
        summary: "List the target systems that have a saved outbound plan",
      },
    },
    async () => ({ targets: deps.outboundTargets.list() }),
  );

  app.post<{ Body: OutboundTransformRequest }>(
    "/outbound/transform",
    {
      schema: {
        tags: ["outbound"],
        summary: "Map a canonical payload to a target system's format",
        description:
          "Applies the saved canonical-to-target plan (no heuristic, no AI) and validates the result against the target system's schema. Does not send anything to the target.",
        body: {
          type: "object",
          required: ["canonicalPayload", "target"],
          properties: {
            canonicalPayload: {
              type: "object",
              additionalProperties: true,
              description: "A valid canonical payload, e.g. targetPayload from /ai/normalize",
            },
            target: {
              type: "object",
              required: ["system", "schemaName"],
              properties: {
                system: { type: "string", description: "Target system (e.g. dhl)" },
                schemaName: { type: "string", description: "Schema name (e.g. shipment-create-request)" },
              },
            },
            parameters: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                "Values for the parameters this target's plan declares (see GET /outbound/targets), e.g. { \"serviceCode\": \"P\" }",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              target: {
                type: "object",
                properties: {
                  system: { type: "string" },
                  schemaName: { type: "string" },
                  planId: { type: "string" },
                  planVersion: { type: "string" },
                },
              },
              targetPayload: {},
              appliedMappings: { type: "array", items: mappingSchema },
              skippedMappings: { type: "array", items: mappingSchema },
              appliedParameters: { type: "array", items: { type: "string" } },
              validation: {
                type: "object",
                properties: {
                  valid: { type: "boolean" },
                  errors: errorListSchema,
                },
              },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await deps.outboundService.transform(request.body);
      } catch (err) {
        if (err instanceof OutboundError) {
          log.warn({ statusCode: err.statusCode, message: err.message }, "Outbound transform rejected");
          return reply.status(err.statusCode).send({ error: err.message, details: err.details });
        }
        if (err instanceof PathError) {
          return reply.status(400).send({ error: err.message });
        }
        log.error({ err }, "Unexpected outbound error");
        return reply.status(500).send({ error: "Internal outbound error" });
      }
    },
  );
}
