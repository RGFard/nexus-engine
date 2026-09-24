/** Request body for POST /ai/generate-mapping */
export interface GenerateMappingRequest {
  sourceSchema: Record<string, unknown>;
  targetSchema: Record<string, unknown>;
  sourceExamplePayload?: Record<string, unknown>;
  targetExamplePayload?: Record<string, unknown>;
  options?: {
    /** Default values for required canonical fields (path → value) */
    defaults?: Record<string, unknown>;
    /**
     * Tenant / client identifier used to look up custom vocabulary.
     * When provided, learned mappings are injected at confidence 1.0 before
     * the heuristic runs, so those fields never reach the AI path again.
     */
    clientId?: string;
  };
}

/** Single field mapping in the transformation plan */
export interface FieldMapping {
  sourceField: string;
  targetField: string;
  confidence: number;
  transformation: string;
  reasoning: string;
}

/** Suggestion for an unmapped required canonical field */
export interface RequiredFieldSuggestion {
  targetField: string;
  description?: string;
  suggestedSourceFields: string[];
  defaultValue?: unknown;
  strategy?: "map" | "default" | "constant" | "derive";
  reasoning: string;
}

/** Response from POST /ai/generate-mapping */
export interface GenerateMappingResponse {
  mappings: FieldMapping[];
  /**
   * Candidates that scored below `autoApplyThreshold` — withheld from
   * auto-apply and surfaced here for human review.  Same shape as `mappings`.
   */
  lowConfidenceMappings?: FieldMapping[];
  unmappedSourceFields: string[];
  unmappedTargetFields: string[];
  requiredFieldSuggestions?: RequiredFieldSuggestion[];
  /**
   * For each unmapped or low-confidence source field, the closest canonical
   * target by name similarity. Read-only — no persistence. Use these paths in
   * POST /vocabulary/accept to teach the engine about opaque field names.
   */
  suggestedMappings?: SuggestedMapping[];
  metadata?: MappingResponseMetadata;
}

/** A best-guess canonical target for an unmapped source field (read-only, no persistence). */
export interface SuggestedMapping {
  /** Source field path with no confident mapping */
  inputField: string;
  /** Closest canonical target path by name similarity */
  suggestedCanonical: string;
  /** 0..1 Dice-coefficient similarity score */
  confidence: number;
  reason: string;
}

export interface MappingResponseMetadata {
  generationMode: "ai" | "heuristic" | "hybrid";
  provider?: "anthropic" | "heuristic";
  model?: string;
  sourceSchemaId?: string;
  targetSchemaId?: string;
  averageConfidence: number;
  heuristicConfidence?: number;
  aiEnhanced?: boolean;
  /** Reserved for future runtime transformation execution */
  transformationPlanVersion: string;
}

/** Internal candidate pair from semantic pre-matching */
export interface CandidateMapping {
  sourceField: string;
  targetField: string;
  confidence: number;
  matchReasons: string[];
  reasoning?: string;
}
