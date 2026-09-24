import type { FieldMapping, GenerateMappingResponse } from "./mapping.types.js";

/**
 * Extension point for future runtime transformation execution.
 * Implementations will apply `FieldMapping` plans to live payloads.
 */
export interface TransformationContext {
  sourcePayload: unknown;
  plan: GenerateMappingResponse;
}

export interface TransformationResult {
  targetPayload: unknown;
  appliedMappings: FieldMapping[];
  skippedMappings: FieldMapping[];
}

export interface TransformationExecutor {
  readonly name: string;
  execute(context: TransformationContext): Promise<TransformationResult>;
}
