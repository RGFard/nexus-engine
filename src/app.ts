import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerSchemaRoutes } from "./routes/schemas.routes.js";
import { schemaRegistry } from "./services/schema-registry.service.js";
import { SchemaValidationService } from "./services/schema-validation.service.js";
import { setLogger } from "./utils/logger.js";

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
}

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  setLogger(app.log);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Canonical Schema Service",
        description:
          "Registry and validation API for canonical JSON Schemas with extensible fields and versioning.",
        version: "1.0.0",
      },
      tags: [{ name: "schemas", description: "Schema registry and validation" }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/documentation",
  });

  await schemaRegistry.initialize();
  const validationService = new SchemaValidationService(schemaRegistry);
  await validationService.initialize();

  app.get("/health", async () => ({ status: "ok" }));

  await registerSchemaRoutes(app, validationService);

  return app;
}
