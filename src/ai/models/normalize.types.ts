import type { ExecuteTransformationOptions, ExecuteTransformationResponse } from "./execution.types.js";
import type { GenerateMappingResponse } from "./mapping.types.js";

/** Target schema reference for registered canonical schemas */
export interface CanonicalTargetRef {
  domain: string;
  schemaName: string;
  version?: string;
}

/** Request body for POST /ai/normalize */
export interface NormalizeRequest {
  sourcePayload: Record<string, unknown>;
  /** Inline source JSON Schema (optional; inferred when omitted) */
  sourceSchema?: Record<string, unknown>;
  /** Inline target JSON Schema (use this or `target`) */
  targetSchema?: Record<string, unknown>;
  /** Registered canonical schema reference (use this or `targetSchema`) */
  target?: CanonicalTargetRef;
  options?: NormalizeOptions;
}

export interface NormalizeOptions extends ExecuteTransformationOptions {
  minConfidence?: number;
  /**
   * Tenant / client identifier. When provided, fields learned via
   * POST /vocabulary/accept resolve at confidence 1.0 and never reach AI.
   */
  clientId?: string;
}

export interface NormalizeResponse {
  plan: GenerateMappingResponse;
  targetPayload: unknown;
  appliedMappings: ExecuteTransformationResponse["appliedMappings"];
  skippedMappings: ExecuteTransformationResponse["skippedMappings"];
  validation?: ExecuteTransformationResponse["validation"];
}
