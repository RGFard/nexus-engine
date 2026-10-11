import { TransformationExecutorService } from "../ai/services/transformation-executor.service.js";
import type { SchemaRegistryService } from "../services/schema-registry.service.js";
import type { SchemaValidationService } from "../services/schema-validation.service.js";
import { createChildLogger } from "../utils/logger.js";
import type { OutboundTargetRegistry } from "./outbound-target.registry.js";
import type { OutboundTransformRequest, OutboundTransformResponse } from "./outbound.types.js";

export class OutboundError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly details?: Array<{ instancePath: string; message?: string }>,
  ) {
    super(message);
    this.name = "OutboundError";
  }
}

/**
 * Canonical payload in, target-system payload out, using a saved plan. No heuristic and
 * no AI call: both ends are fixed schemas, so the mapping never changes per request.
 */
export class OutboundService {
  // No validation service: the executor only knows registered canonical schemas, and the
  // target is validated here against its own schema instead.
  private readonly executor = new TransformationExecutorService();

  constructor(
    private readonly targets: OutboundTargetRegistry,
    private readonly schemaRegistry: SchemaRegistryService,
    private readonly validationService: SchemaValidationService,
  ) {}

  async transform(request: OutboundTransformRequest): Promise<OutboundTransformResponse> {
    const log = createChildLogger({ component: "outbound" });
    const { system, schemaName } = request.target;

    const target = this.targets.get(system, schemaName);
    if (!target) {
      const known = this.targets.list().map((t) => `${t.system}/${t.schemaName}`);
      throw new OutboundError(
        `Unknown outbound target: ${system}/${schemaName}. Available: ${known.join(", ") || "none"}`,
        404,
      );
    }

    // Refuse anything that is not valid canonical. Mapping a wrong-shaped payload (for
    // example the whole /ai/normalize response instead of its targetPayload) would
    // produce a mostly empty target request rather than an error.
    const source = this.schemaRegistry.getAllSchemas().find((s) => s.id === target.plan.sourceSchemaId);
    if (!source) {
      throw new OutboundError(
        `Plan ${target.plan.planId} reads from ${target.plan.sourceSchemaId}, which is not a registered schema`,
        500,
      );
    }
    const sourceCheck = this.validationService.validate(
      source.domain,
      source.name,
      request.canonicalPayload,
      source.version,
    );
    if (!sourceCheck.valid) {
      throw new OutboundError(
        `canonicalPayload is not a valid ${target.plan.sourceSchemaId}`,
        422,
        sourceCheck.errors?.map((e) => ({ instancePath: e.instancePath, message: e.message })),
      );
    }

    const execution = await this.executor.executeWithOptions({
      sourcePayload: request.canonicalPayload,
      plan: target.plan,
    });

    const valid = target.validate(execution.targetPayload) as boolean;
    const errors = valid
      ? undefined
      : (target.validate.errors ?? []).map((e) => ({ instancePath: e.instancePath, message: e.message }));

    log.info(
      {
        system,
        schemaName,
        planId: target.plan.planId,
        applied: execution.appliedMappings.length,
        skipped: execution.skippedMappings.length,
        valid,
        errorCount: errors?.length ?? 0,
      },
      "Outbound transform completed",
    );

    return {
      target: { system, schemaName, planId: target.plan.planId, planVersion: target.plan.planVersion },
      targetPayload: execution.targetPayload,
      appliedMappings: execution.appliedMappings,
      skippedMappings: execution.skippedMappings,
      validation: { valid, errors },
    };
  }
}
