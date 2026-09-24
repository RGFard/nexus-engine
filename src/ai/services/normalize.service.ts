import type { NormalizeRequest, NormalizeResponse } from "../models/normalize.types.js";
import { applyCanonicalDefaults } from "../utils/canonical-defaults.js";
import { aiLog } from "../utils/ai-logger.js";
import { AiMappingError, aiMappingService } from "./ai-mapping.service.js";
import { semanticMatcherService } from "./semantic-matcher.service.js";
import type { TransformationExecutorRegistry } from "./transformation-executor.service.js";
import type { SchemaRegistryService } from "../../services/schema-registry.service.js";

const log = aiLog("normalize");

export class NormalizeService {
  constructor(
    private readonly transformationRegistry: TransformationExecutorRegistry,
    private readonly schemaRegistry: SchemaRegistryService,
  ) {}

  async normalize(request: NormalizeRequest): Promise<NormalizeResponse> {
    this.validateRequest(request);

    const targetSchema = this.resolveTargetSchema(request);
    const sourceSchema =
      request.sourceSchema ??
      semanticMatcherService.inferSchemaFromPayload(
        request.sourcePayload,
        "CarrierSource",
      );

    log.info(
      {
        targetSchemaId: targetSchema.$id,
        sourceInferred: !request.sourceSchema,
        sourcePropertyCount: Object.keys(
          (sourceSchema.properties as Record<string, unknown>) ?? {},
        ).length,
      },
      "Starting autonomous normalization",
    );

    const plan = await aiMappingService.generateMapping({
      sourceSchema,
      targetSchema,
      sourceExamplePayload: request.sourcePayload,
      options: { clientId: request.options?.clientId },
    });

    log.info(
      {
        mappingCount: plan.mappings.length,
        generationMode: plan.metadata?.generationMode,
        aiEnhanced: plan.metadata?.aiEnhanced,
        averageConfidence: plan.metadata?.averageConfidence,
      },
      "Mapping plan produced for normalize",
    );

    const validateTarget =
      request.options?.validateTarget ??
      (request.target
        ? {
            domain: request.target.domain,
            schemaName: request.target.schemaName,
            version: request.target.version,
          }
        : undefined);

    const applyCanonicalDefaultsOption =
      request.options?.applyCanonicalDefaults ?? Boolean(validateTarget);

    const execution = await this.transformationRegistry.executeTransformation({
      sourcePayload: request.sourcePayload,
      plan,
      options: {
        ...request.options,
        validateTarget,
        applyCanonicalDefaults: applyCanonicalDefaultsOption,
        targetSchemaForDefaults: applyCanonicalDefaultsOption ? targetSchema : undefined,
      },
    });

    log.info(
      {
        applied: execution.appliedMappings.length,
        skipped: execution.skippedMappings.length,
        valid: execution.validation?.valid,
      },
      "Normalization completed",
    );

    return {
      plan,
      targetPayload: execution.targetPayload,
      appliedMappings: execution.appliedMappings,
      skippedMappings: execution.skippedMappings,
      validation: execution.validation,
    };
  }

  private resolveTargetSchema(request: NormalizeRequest): Record<string, unknown> {
    if (request.targetSchema) {
      return request.targetSchema;
    }

    if (request.target) {
      const registered = this.schemaRegistry.get(
        request.target.domain,
        request.target.schemaName,
        request.target.version,
      );
      if (!registered) {
        throw new AiMappingError(
          `Target schema not found: ${request.target.domain}/${request.target.schemaName}`,
          404,
        );
      }
      return registered.schema;
    }

    throw new AiMappingError("Provide targetSchema or target (domain + schemaName)", 400);
  }

  private validateRequest(request: NormalizeRequest): void {
    if (!request.sourcePayload || typeof request.sourcePayload !== "object") {
      throw new AiMappingError("sourcePayload is required and must be an object", 400);
    }
  }
}
