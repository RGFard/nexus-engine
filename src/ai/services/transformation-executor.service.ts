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
  PathError,
  pathDepth,
  resolveMappingSourceValue,
  setByPath,
} from "../utils/json-path.js";
import { applyCanonicalDefaults } from "../utils/canonical-defaults.js";
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
        log.info(
          {
            sourceField: mapping.sourceField,
            targetField: mapping.targetField,
            reason: "below_confidence_threshold",
            confidence: mapping.confidence,
            minConfidence,
          },
          "Mapping skipped",
        );
        continue;
      }

      try {
        const result = this.applyMapping(request.sourcePayload, targetPayload, mapping);
        if (result.applied) {
          appliedMappings.push(mapping);
          log.info(
            {
              sourceField: mapping.sourceField,
              targetField: mapping.targetField,
              sourceValue: summarizeValue(result.sourceValue),
              targetValue: summarizeValue(result.targetValue),
              transformation: mapping.transformation,
            },
            "Mapping applied",
          );
        } else {
          skippedMappings.push(mapping);
          log.warn(
            {
              sourceField: mapping.sourceField,
              targetField: mapping.targetField,
              reason: result.skipReason,
              sourceValue: summarizeValue(result.sourceValue),
              transformation: mapping.transformation,
            },
            "Mapping skipped",
          );
        }
      } catch (err) {
        log.warn(
          {
            err,
            sourceField: mapping.sourceField,
            targetField: mapping.targetField,
            reason: "exception",
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
        targetKeys: Object.keys(targetPayload),
      },
      "Transformation execution completed",
    );

    pruneIncompleteMoneyObjects(targetPayload);

    if (
      options.applyCanonicalDefaults &&
      options.targetSchemaForDefaults &&
      isPlainObject(targetPayload)
    ) {
      const filled = applyCanonicalDefaults(targetPayload, options.targetSchemaForDefaults);
      if (filled.length > 0) {
        log.info({ paths: filled }, "Applied canonical default values");
      }
    }

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
  ): {
    applied: boolean;
    skipReason?: string;
    sourceValue?: unknown;
    targetValue?: unknown;
  } {
    const sourceValue = resolveMappingSourceValue(
      sourcePayload,
      mapping.sourceField,
      mapping.targetField,
    );

    if (sourceValue === undefined) {
      if (!mapping.transformation.includes("constant:")) {
        return { applied: false, skipReason: "source_value_undefined", sourceValue };
      }
    }

    let transformed = applyTransformationSteps(sourceValue, mapping.transformation, {
      sourcePayload,
      mapping,
    });

    if (transformed === undefined) {
      return {
        applied: false,
        skipReason: "transform_result_undefined",
        sourceValue,
      };
    }

    if (
      isParentArrayMap(mapping) &&
      Array.isArray(transformed)
    ) {
      transformed = transformed.map(() => ({}));
    }

    if (mapping.targetField.endsWith("/weight/unit")) {
      transformed = applyTransformationSteps(transformed, "normalize:weightUnit", {
        sourcePayload,
        mapping,
      });
    }

    if (mapping.targetField.endsWith("/dimensions/unit")) {
      transformed = applyTransformationSteps(transformed, "normalize:dimensionUnit", {
        sourcePayload,
        mapping,
      });
    }

    const lineIndexMatch = mapping.targetField.match(/\/line([123])$/);
    if (lineIndexMatch && Array.isArray(transformed)) {
      const idx = parseInt(lineIndexMatch[1]!, 10) - 1;
      transformed = (transformed as unknown[])[idx];
    }

    if (mapping.targetField.endsWith("/weight/value") && !Array.isArray(transformed)) {
      transformed = applyTransformationSteps(transformed, "cast:number", {
        sourcePayload,
        mapping,
      });
    }

    const mergedValue = mergeExtensionsTarget(targetPayload, mapping.targetField, transformed);

    try {
      setByPath(targetPayload, mapping.targetField, mergedValue);
      const targetValue = getByPath(targetPayload, mapping.targetField);
      return { applied: true, sourceValue, targetValue };
    } catch (err) {
      return {
        applied: false,
        skipReason: err instanceof Error ? err.message : "set_path_failed",
        sourceValue,
      };
    }
  }
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

  if (targetField === "/extensions") {
    const existingExt = getByPath(targetPayload, "/extensions");
    if (isPlainObject(existingExt)) {
      return { ...existingExt, ...transformed };
    }
  }

  return transformed;
}

function isParentArrayMap(mapping: FieldMapping): boolean {
  return (
    mapping.transformation.includes("array:map") &&
    !mapping.targetField.includes("[]")
  );
}

function sortMappingsForApply(mappings: FieldMapping[]): FieldMapping[] {
  return [...mappings].sort((a, b) => {
    const aIsParent = isParentArrayMap(a);
    const bIsParent = isParentArrayMap(b);
    if (aIsParent !== bIsParent) {
      return aIsParent ? -1 : 1;
    }
    const depthDiff = pathDepth(b.targetField) - pathDepth(a.targetField);
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return a.targetField.localeCompare(b.targetField);
  });
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > 120) {
    return `${value.slice(0, 120)}...`;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes any `declaredValue` object that is missing a required Money field
 * (`amount` or `currency`). A partial Money object fails schema validation and
 * must not be emitted when only one sibling can be sourced from the input.
 */
function pruneIncompleteMoneyObjects(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    const val = payload[key];
    if (key === "declaredValue" && isPlainObject(val)) {
      if (!("amount" in val) || !("currency" in val)) {
        delete payload[key];
      }
      continue;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (isPlainObject(item)) {
          pruneIncompleteMoneyObjects(item);
        }
      }
    } else if (isPlainObject(val)) {
      pruneIncompleteMoneyObjects(val);
    }
  }
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
