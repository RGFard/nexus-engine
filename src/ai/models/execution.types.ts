import type { FieldMapping, GenerateMappingResponse } from "./mapping.types.js";
import type { TransformationResult } from "./execution.interface.js";

/** Request body for POST /ai/execute-transformation */
export interface ExecuteTransformationRequest {
  sourcePayload: unknown;
  plan: GenerateMappingResponse;
  options?: ExecuteTransformationOptions;
}

export interface ExecuteTransformationOptions {
  /** Minimum mapping confidence to apply (default 0) */
  minConfidence?: number;
  /** Merge into an existing target object instead of starting empty */
  mergeTarget?: boolean;
  /** Initial target object when mergeTarget is true */
  initialTarget?: Record<string, unknown>;
  /** Validate result against a registered canonical schema */
  validateTarget?: {
    domain: string;
    schemaName: string;
    version?: string;
  };
  /**
   * Fill missing top-level fields using x-canonical-default from the target schema
   * before validation (default true when validateTarget is set).
   */
  applyCanonicalDefaults?: boolean;
  /** Inline target schema used to resolve x-canonical-default (normalize passes this) */
  targetSchemaForDefaults?: Record<string, unknown>;
}

export interface ExecuteTransformationResponse extends TransformationResult {
  validation?: {
    valid: boolean;
    errors?: Array<{
      instancePath: string;
      message?: string;
    }>;
  };
}

export type { TransformationContext, TransformationResult } from "./execution.interface.js";
export type { FieldMapping };
