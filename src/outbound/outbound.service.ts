import { TransformationExecutorService } from "../ai/services/transformation-executor.service.js";
import { setByPath } from "../ai/utils/json-path.js";
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

    // Check parameters before doing any work: a misspelled name must be an error, not a
    // value that is quietly ignored while the request goes out without it.
    const declared = target.plan.parameters ?? {};
    const supplied = request.parameters ?? {};
    for (const [name, value] of Object.entries(supplied)) {
      if (!declared[name]) {
        const accepted = Object.keys(declared);
        throw new OutboundError(
          `Unknown parameter "${name}" for ${system}/${schemaName}. Accepted: ${accepted.join(", ") || "none"}`,
          400,
        );
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new OutboundError(`Parameter "${name}" must be a non-empty string`, 400);
      }
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

    // Parameters are written after the mappings, so a supplied value wins over whatever
    // the canonical payload carried for the same target field.
    const appliedParameters: string[] = [];
    for (const [name, value] of Object.entries(supplied)) {
      setByPath(execution.targetPayload, declared[name]!.targetField, value.trim());
      appliedParameters.push(name);
    }

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
        parameters: appliedParameters,
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
      appliedParameters,
      validation: { valid, errors },
    };
  }
}
