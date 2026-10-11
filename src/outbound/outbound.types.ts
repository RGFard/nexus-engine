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
  /** Things the plan is known not to handle yet */
  knownGaps?: string[];
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
  validation: OutboundValidation;
}

export interface OutboundTargetListItem extends OutboundTargetRef {
  planId: string;
  planVersion: string;
  sourceSchemaId: string;
  targetSchemaId: string;
  mappingCount: number;
  knownGaps: string[];
}
