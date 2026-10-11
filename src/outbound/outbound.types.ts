import type { FieldMapping, GenerateMappingResponse } from "../ai/models/mapping.types.js";

/** A saved, fixed mapping plan from a canonical schema to one target system's schema. */
export interface SavedOutboundPlan extends GenerateMappingResponse {
  planId: string;
  planVersion: string;
  description?: string;
  /** $id of the canonical schema the plan reads from, e.g. canonical://shipment/shipment-create-request */
  sourceSchemaId: string;
  /** $id of the target schema the plan writes to */
  targetSchemaId: string;
  /**
   * Values the caller supplies with the request instead of the canonical payload: things
   * that belong to the sender's dealings with this target, not to the shipment data.
   * Keyed by parameter name.
   */
  parameters?: Record<string, OutboundPlanParameter>;
  /** Things the plan is known not to handle yet */
  knownGaps?: string[];
}

export interface OutboundPlanParameter {
  /** Where the value is written in the target payload */
  targetField: string;
  description?: string;
}

export interface OutboundTargetRef {
  /** Target system folder name, e.g. "dhl" */
  system: string;
  /** Schema / plan name, e.g. "shipment-create-request" */
  schemaName: string;
}

/** Request body for POST /outbound/transform */
export interface OutboundTransformRequest {
  canonicalPayload: Record<string, unknown>;
  target: OutboundTargetRef;
  /** Values for the parameters the target's plan declares, e.g. { "serviceCode": "P" } */
  parameters?: Record<string, string>;
}

export interface OutboundValidation {
  valid: boolean;
  errors?: Array<{ instancePath: string; message?: string }>;
}

/** Response from POST /outbound/transform */
export interface OutboundTransformResponse {
  target: OutboundTargetRef & { planId: string; planVersion: string };
  targetPayload: unknown;
  appliedMappings: FieldMapping[];
  skippedMappings: FieldMapping[];
  /** Names of the request parameters that were written into the target payload */
  appliedParameters: string[];
  validation: OutboundValidation;
}

export interface OutboundTargetListItem extends OutboundTargetRef {
  planId: string;
  planVersion: string;
  sourceSchemaId: string;
  targetSchemaId: string;
  mappingCount: number;
  parameters: Record<string, OutboundPlanParameter>;
  knownGaps: string[];
}
