import type { FastifyInstance } from "fastify";
import type { ValidateSchemaRequest } from "../models/schema.types.js";
import { schemaRegistry } from "../services/schema-registry.service.js";
import type { SchemaValidationService } from "../services/schema-validation.service.js";

export async function registerSchemaRoutes(
  app: FastifyInstance,
  validationService: SchemaValidationService,
): Promise<void> {
  app.get(
    "/schemas",
    {
      schema: {
        tags: ["schemas"],
        summary: "List all canonical schemas",
        response: {
          200: {
            type: "object",
            properties: {
              schemas: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    domain: { type: "string" },
                    name: { type: "string" },
                    version: { type: "string" },
                    id: { type: "string" },
                    title: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      return { schemas: schemaRegistry.list() };
    },
  );

  app.get<{
    Params: { domain: string; schemaName: string };
    Querystring: { version?: string };
  }>(
    "/schemas/:domain/:schemaName",
    {
      schema: {
        tags: ["schemas"],
        summary: "Retrieve a canonical schema by domain and name",
        params: {
          type: "object",
          required: ["domain", "schemaName"],
          properties: {
            domain: { type: "string" },
            schemaName: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            version: { type: "string", description: "Semantic version; latest if omitted" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              domain: { type: "string" },
              name: { type: "string" },
              version: { type: "string" },
              id: { type: "string" },
              availableVersions: { type: "array", items: { type: "string" } },
              schema: { type: "object", additionalProperties: true },
            },
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { domain, schemaName } = request.params;
      const { version } = request.query;

      const registered = schemaRegistry.get(domain, schemaName, version);
      if (!registered) {
        return reply.status(404).send({
          error: `Schema not found: ${domain}/${schemaName}${version ? `@${version}` : ""}`,
        });
      }

      return {
        domain: registered.domain,
        name: registered.name,
        version: registered.version,
        id: registered.id,
        availableVersions: schemaRegistry.getVersions(domain, schemaName),
        schema: registered.schema,
      };
    },
  );

  app.post<{ Body: ValidateSchemaRequest }>(
    "/schemas/validate",
    {
      schema: {
        tags: ["schemas"],
        summary: "Validate a payload against a canonical schema",
        body: {
          type: "object",
          required: ["domain", "schemaName", "data"],
          properties: {
            domain: { type: "string" },
            schemaName: { type: "string" },
            version: { type: "string" },
            data: {},
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              valid: { type: "boolean" },
              domain: { type: "string" },
              schemaName: { type: "string" },
              version: { type: "string" },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    instancePath: { type: "string" },
                    schemaPath: { type: "string" },
                    keyword: { type: "string" },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { domain, schemaName, version, data } = request.body;

      const registered = schemaRegistry.get(domain, schemaName, version);
      if (!registered) {
        return reply.status(404).send({
          error: `Schema not found: ${domain}/${schemaName}${version ? `@${version}` : ""}`,
        });
      }

      const result = validationService.validate(domain, schemaName, data, version);

      return {
        valid: result.valid,
        domain,
        schemaName,
        version: registered.version,
        ...(result.errors ? { errors: result.errors } : {}),
      };
    },
  );
}
