import type {
  TransformationContext,
  TransformationExecutor,
  TransformationResult,
} from "../models/execution.interface.js";
import type {
  ExecuteTransformationOptions,
  ExecuteTransformationRequest,
  ExecuteTransformationResponse,
} from "../models/execution.types.js";
import type { FieldMapping } from "../models/mapping.types.js";
import { aiLog } from "../utils/ai-logger.js";
import {
  createEmptyTarget,
  getByPath,
  parsePath,
  PathError,
  pathDepth,
  setByPath,
} from "../utils/json-path.js";
import { applyTransformationSteps } from "./transformation-engine.js";
import type { SchemaValidationService } from "../../services/schema-validation.service.js";

const log = aiLog("transformation-executor");

export class TransformationExecutorService implements TransformationExecutor {
  readonly name = "default";

  constructor(private readonly validationService?: SchemaValidationService) {}

  async execute(context: TransformationContext): Promise<TransformationResult> {
    return this.executeWithOptions({
      sourcePayload: context.sourcePayload,
      plan: context.plan,
    });
  }

  async executeWithOptions(
    request: ExecuteTransformationRequest,
  ): Promise<ExecuteTransformationResponse> {
    const options = request.options ?? {};
    const minConfidence = options.minConfidence ?? 0;

    const targetPayload = options.mergeTarget
      ? createEmptyTarget(options.initialTarget)
      : createEmptyTarget();

    const appliedMappings: FieldMapping[] = [];
    const skippedMappings: FieldMapping[] = [];

    const ordered = sortMappingsForApply(request.plan.mappings);

    log.info(
      {
        mappingCount: ordered.length,
        minConfidence,
        mergeTarget: options.mergeTarget ?? false,
      },
      "Starting transformation execution",
    );

    for (const mapping of ordered) {
      if (mapping.confidence < minConfidence) {
        skippedMappings.push(mapping);
        log.debug(
          { sourceField: mapping.sourceField, confidence: mapping.confidence },
          "Skipped mapping below confidence threshold",
        );
        continue;
      }

      try {
        const applied = this.applyMapping(
          request.sourcePayload,
          targetPayload,
          mapping,
        );
        if (applied) {
          appliedMappings.push(mapping);
        } else {
          skippedMappings.push(mapping);
        }
      } catch (err) {
        log.warn(
          {
            err,
            sourceField: mapping.sourceField,
            targetField: mapping.targetField,
            transformation: mapping.transformation,
          },
          "Mapping application failed",
        );
        skippedMappings.push(mapping);
      }
    }

    log.info(
      {
        applied: appliedMappings.length,
        skipped: skippedMappings.length,
      },
      "Transformation execution completed",
    );

    const response: ExecuteTransformationResponse = {
      targetPayload,
      appliedMappings,
      skippedMappings,
    };

    if (options.validateTarget && this.validationService) {
      const { domain, schemaName, version } = options.validateTarget;
      const validation = this.validationService.validate(
        domain,
        schemaName,
        targetPayload,
        version,
      );
      response.validation = {
        valid: validation.valid,
        errors: validation.errors?.map((e) => ({
          instancePath: e.instancePath,
          message: e.message,
        })),
      };
      if (!validation.valid) {
        log.warn(
          { domain, schemaName, errorCount: validation.errors?.length },
          "Target payload failed schema validation",
        );
      }
    }

    return response;
  }

  private applyMapping(
    sourcePayload: unknown,
    targetPayload: Record<string, unknown>,
    mapping: FieldMapping,
  ): boolean {
    const sourceValue = resolveSourceValue(sourcePayload, mapping);

    if (sourceValue === undefined) {
      if (!mapping.transformation.includes("constant:")) {
        return false;
      }
    }

    const transformed = applyTransformationSteps(sourceValue, mapping.transformation, {
      sourcePayload,
      mapping,
    });

    if (transformed === undefined) {
      return false;
    }

    const mergedValue = mergeExtensionsTarget(targetPayload, mapping.targetField, transformed);
    setByPath(targetPayload, mapping.targetField, mergedValue);
    return true;
  }
}

function resolveSourceValue(sourcePayload: unknown, mapping: FieldMapping): unknown {
  const segments = parsePath(mapping.sourceField);
  const hasArray = segments.some((s) => s.isArray);

  if (!hasArray) {
    return getByPath(sourcePayload, mapping.sourceField);
  }

  const value = getByPath(sourcePayload, mapping.sourceField);

  if (mapping.transformation.includes("array:map") && Array.isArray(value)) {
    return value;
  }

  return value;
}

function mergeExtensionsTarget(
  targetPayload: Record<string, unknown>,
  targetField: string,
  transformed: unknown,
): unknown {
  if (!targetField.includes("/extensions")) {
    return transformed;
  }

  if (!isPlainObject(transformed)) {
    return transformed;
  }

  const existing = getByPath(targetPayload, targetField);
  if (isPlainObject(existing)) {
    return { ...existing, ...transformed };
  }

  const extensionsRoot = targetField.match(/^(\/extensions)/);
  if (extensionsRoot && targetField === "/extensions") {
    const existingExt = getByPath(targetPayload, "/extensions");
    if (isPlainObject(existingExt)) {
      return { ...existingExt, ...transformed };
    }
  }

  return transformed;
}

function sortMappingsForApply(mappings: FieldMapping[]): FieldMapping[] {
  return [...mappings].sort((a, b) => {
    const depthDiff = pathDepth(b.targetField) - pathDepth(a.targetField);
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return a.targetField.localeCompare(b.targetField);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TransformationExecutorRegistry {
  private readonly executors = new Map<string, TransformationExecutor>();
  private defaultName = "default";

  constructor(defaultExecutor: TransformationExecutor) {
    this.register(defaultExecutor, true);
  }

  register(executor: TransformationExecutor, isDefault = false): void {
    this.executors.set(executor.name, executor);
    if (isDefault) {
      this.defaultName = executor.name;
    }
  }

  get(name?: string): TransformationExecutor {
    const key = name ?? this.defaultName;
    const executor = this.executors.get(key);
    if (!executor) {
      throw new Error(`Transformation executor not found: ${key}`);
    }
    return executor;
  }

  list(): string[] {
    return [...this.executors.keys()];
  }

  async executeTransformation(
    request: ExecuteTransformationRequest,
    executorName?: string,
  ): Promise<ExecuteTransformationResponse> {
    const executor = this.get(executorName);
    if (!(executor instanceof TransformationExecutorService)) {
      throw new Error("Registered executor does not support executeWithOptions");
    }
    return executor.executeWithOptions(request);
  }
}

export function createTransformationExecutorRegistry(
  validationService?: SchemaValidationService,
): TransformationExecutorRegistry {
  const executor = new TransformationExecutorService(validationService);
  return new TransformationExecutorRegistry(executor);
}

export { PathError };
