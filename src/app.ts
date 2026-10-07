import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerAiMappingRoutes } from "./ai/routes/ai-mapping.routes.js";
import { registerVocabularyRoutes } from "./ai/routes/vocabulary.routes.js";
import { createTransformationExecutorRegistry } from "./ai/services/transformation-executor.service.js";
import { schemaRefResolver } from "./ai/services/schema-ref-resolver.service.js";
import { semanticMatcherService } from "./ai/services/semantic-matcher.service.js";
import { CanonicalFieldsService } from "./ai/services/canonical-fields.service.js";
import { vocabularyStore } from "./ai/services/custom-vocabulary.store.js";
import { learnedVocabularyStore } from "./ai/services/learned-vocabulary.store.js";
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
          "Registry and validation API for canonical JSON Schemas, plus AI semantic mapping between schemas.",
        version: "1.0.0",
      },
      tags: [
        { name: "schemas", description: "Schema registry and validation" },
        { name: "ai", description: "AI semantic mapping engine" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/documentation",
  });

  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
  const validationService = new SchemaValidationService(schemaRegistry);
  await validationService.initialize();

  const canonicalFields = new CanonicalFieldsService(schemaRegistry);
  canonicalFields.initialize();

  app.get("/health", async () => ({ status: "ok" }));

  const transformationRegistry = createTransformationExecutorRegistry(validationService);

  await registerSchemaRoutes(app, validationService);
  await registerAiMappingRoutes(app, {
    transformationRegistry,
    schemaRegistry,
  });
  await registerVocabularyRoutes(app, {
    vocabularyStore,
    canonicalFields,
    learnedVocabularyStore,
  });

  return app;
}
