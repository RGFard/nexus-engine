import type { FieldMapping, GenerateMappingResponse } from "../ai/models/mapping.types.js";
import type { UnitConversion, UnitPolicy } from "./unit-conversion.js";

/** A saved, fixed mapping plan from a canonical schema to one target system's schema. */
export interface SavedOutboundPlan extends GenerateMappingResponse {
  planId: string;
  planVersion: string;
  description?: string;
  /** Name used in messages to the caller, e.g. "FedEx". Defaults to the system folder name. */
  targetName?: string;
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
  /**
   * Fixed values the target needs but canonical does not carry (FedEx pickupType, label
   * format), keyed by target path. Written only where the mappings left the path empty,
   * so mapped data wins; request parameters still win over both.
   */
  defaults?: Record<string, string | number | boolean>;
  /**
   * Blocks the target rejects when they are incomplete: block path to the path that must
   * exist inside it. When that path is missing the whole block is removed (FedEx takes no
   * customsClearanceDetail without commodities).
   */
  dropIfMissing?: Record<string, string>;
  /** Which canonical units the target takes, and what to convert the others to */
  units?: UnitPolicy;
  /** Things the plan is known not to handle yet */
  knownGaps?: string[];
}

export interface OutboundPlanParameter {
  /** Where the value is written in the target payload */
  targetField: string;
  /** The request header a caller uses to send this value, named in error messages */
  header?: string;
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
  errors?: Array<{ instancePath: string; message?: string; canonicalField?: string; header?: string }>;
}

/** Response from POST /outbound/transform */
export interface OutboundTransformResponse {
  target: OutboundTargetRef & { planId: string; planVersion: string };
  targetPayload: unknown;
  appliedMappings: FieldMapping[];
  skippedMappings: FieldMapping[];
  /** Blocks removed because a path they need was missing */
  droppedBlocks: string[];
  /** Target paths filled from the plan's fixed defaults */
  appliedDefaults: string[];
  /** Names of the request parameters that were written into the target payload */
  appliedParameters: string[];
  /** Every weight or dimensions block that was converted to a unit the target takes */
  unitConversions: UnitConversion[];
  validation: OutboundValidation;
}

export interface OutboundTargetListItem extends OutboundTargetRef {
  planId: string;
  planVersion: string;
  sourceSchemaId: string;
  targetSchemaId: string;
  mappingCount: number;
  parameters: Record<string, OutboundPlanParameter>;
  defaults: Record<string, string | number | boolean>;
  units: UnitPolicy;
  knownGaps: string[];
}
