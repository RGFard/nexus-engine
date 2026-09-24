import type { FastifyInstance } from "fastify";
import type { NormalizeRequest } from "../models/normalize.types.js";
import { AiMappingError } from "../services/ai-mapping.service.js";
import { NormalizeService } from "../services/normalize.service.js";
import type { TransformationExecutorRegistry } from "../services/transformation-executor.service.js";
import { PathError } from "../services/transformation-executor.service.js";
import { aiLog } from "../utils/ai-logger.js";
import type { SchemaRegistryService } from "../../services/schema-registry.service.js";

const log = aiLog("routes");

const mappingSchema = {
  type: "object",
  required: ["sourceField", "targetField", "confidence", "transformation", "reasoning"],
  properties: {
    sourceField: { type: "string" },
    targetField: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    transformation: { type: "string" },
    reasoning: { type: "string" },
  },
} as const;

const planSchema = {
  type: "object",
  required: ["mappings", "unmappedSourceFields", "unmappedTargetFields"],
  properties: {
    mappings: { type: "array", items: mappingSchema },
    unmappedSourceFields: { type: "array", items: { type: "string" } },
    unmappedTargetFields: { type: "array", items: { type: "string" } },
    metadata: { type: "object", additionalProperties: true },
  },
} as const;

const executeOptionsSchema = {
  type: "object",
  properties: {
    minConfidence: { type: "number", minimum: 0, maximum: 1 },
    clientId: { type: "string" },
    mergeTarget: { type: "boolean" },
    initialTarget: { type: "object", additionalProperties: true },
    validateTarget: {
      type: "object",
      required: ["domain", "schemaName"],
      properties: {
        domain: { type: "string" },
        schemaName: { type: "string" },
        version: { type: "string" },
      },
    },
  },
} as const;

export interface AiRouteDeps {
  transformationRegistry: TransformationExecutorRegistry;
  schemaRegistry: SchemaRegistryService;
}

export async function registerAiMappingRoutes(
  app: FastifyInstance,
  deps: AiRouteDeps,
): Promise<void> {
  const normalizeService = new NormalizeService(deps.transformationRegistry, deps.schemaRegistry);

  app.post<{ Body: NormalizeRequest }>(
    "/ai/normalize",
    {
      schema: {
        tags: ["ai"],
        summary: "Map and transform a source payload to a canonical schema",
        description:
          "End-to-end normalization: generates a semantic mapping plan, executes transformations, and optionally validates against a registered canonical schema.",
        body: {
          type: "object",
          required: ["sourcePayload"],
          properties: {
            sourcePayload: {
              type: "object",
              additionalProperties: true,
              description: "Carrier or legacy payload to normalize",
            },
            sourceSchema: {
              type: "object",
              additionalProperties: true,
              description: "Optional source JSON Schema",
            },
            targetSchema: {
              type: "object",
              additionalProperties: true,
              description: "Inline target JSON Schema (alternative to `target`)",
            },
            target: {
              type: "object",
              required: ["domain", "schemaName"],
              properties: {
                domain: { type: "string", description: "Schema domain (e.g. shipment)" },
                schemaName: { type: "string", description: "Schema name (e.g. shipment-create-request)" },
                version: { type: "string", description: "Optional schema version" },
              },
            },
            options: executeOptionsSchema,
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              plan: planSchema,
              targetPayload: {},
              appliedMappings: { type: "array", items: mappingSchema },
              skippedMappings: { type: "array", items: mappingSchema },
              validation: {
                type: "object",
                properties: {
                  valid: { type: "boolean" },
                  errors: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        instancePath: { type: "string" },
                        message: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          502: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      try {
        return await normalizeService.normalize(request.body);
      } catch (err) {
        if (err instanceof AiMappingError) {
          log.error({ statusCode: err.statusCode, message: err.message }, "Normalize request failed");
          return reply.status(err.statusCode).send({ error: err.message });
        }
        if (err instanceof PathError) {
          return reply.status(400).send({ error: err.message });
        }
        log.error({ err }, "Unexpected normalize error");
        return reply.status(500).send({ error: "Internal normalization error" });
      }
    },
  );
}
