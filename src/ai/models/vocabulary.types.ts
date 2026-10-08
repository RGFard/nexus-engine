export interface VocabularyEntry {
  /** Arbitrary input field name — never validated or rejected */
  inputField: string;
  /** A real canonical leaf path (JSON Pointer, e.g. /packages[]/weight/value) */
  canonicalField: string;
}

export interface SuggestedMapping {
  /** Source field path that has no confident mapping */
  inputField: string;
  /** Best-guess canonical target path */
  suggestedCanonical: string;
  /** 0..1 name-similarity score */
  confidence: number;
  reason: string;
}

export interface AcceptVocabularyRequest {
  clientId: string;
  acceptedMappings: Array<{ inputField: string; canonicalField: string }>;
}

export interface AcceptVocabularyResult {
  accepted: VocabularyEntry[];
  rejected: Array<{ inputField: string; canonicalField: string; reason: string }>;
}

/**
 * Global learned vocabulary entry — same shape as VocabularyEntry, plus the
 * transformation the AI chose so accepting it reproduces the AI result exactly.
 */
export interface LearnedVocabularyEntry extends VocabularyEntry {
  transformation: string;
  acceptedAt: string;
}

/** An AI-fallback mapping awaiting accept/reject. */
export interface PendingVocabularyEntry {
  /** Stable id derived from sourceField + targetField */
  id: string;
  sourceField: string;
  targetField: string;
  transformation: string;
  confidence: number;
  reasoning: string;
  /** Context that produced it (most recent sighting) */
  context: {
    sourceSchemaId?: string;
    targetSchemaId?: string;
    clientId?: string;
  };
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  /**
   * Every known carrier/ERP schema (DHL, FedEx, UPS, SAP/ERP, ShipStation) a
   * payload containing this field has matched, comma-separated and built up
   * across sightings — e.g. seen once from a DHL payload and later from a UPS
   * one becomes "DHL,UPS". null if no sighting's payload matched a known
   * schema. Each sighting's match comes from utils/source-system.ts, which
   * looks at that request's whole payload, not just this one field.
   */
  sourceSystem: string | null;
}

/**
 * Input to LearnedVocabularyStore.recordPending — store fills in id/timestamps,
 * and merges detectedSourceSystem into the entry's accumulated sourceSystem list.
 */
export type PendingVocabularyInput = Omit<
  PendingVocabularyEntry,
  "id" | "firstSeenAt" | "lastSeenAt" | "seenCount" | "sourceSystem"
> & {
  /** Which known schema THIS sighting's whole payload matched, or null if none did. */
  detectedSourceSystem: string | null;
};

/**
 * A pending mapping that was rejected rather than accepted — kept, not dropped,
 * so a deliberate "not this" decision survives for a future look instead of just
 * vanishing (a plain reject previously discarded the entry outright; the AI would
 * eventually propose it again from scratch with no memory of the earlier call).
 */
export interface ReconsiderVocabularyEntry extends PendingVocabularyEntry {
  /** Why it was held back instead of accepted (e.g. "lost to a competing target, seen 2x vs 7x") */
  reason: string;
  rejectedAt: string;
}

/**
 * A reconsider entry as listed back out, enriched with what the global vocabulary
 * currently uses for this source field (if anything) — so "what did we pick
 * instead" is answered right there instead of requiring a manual cross-reference
 * against custom_vocabulary.json.
 */
export interface ReconsiderVocabularyEntryWithSelection extends ReconsiderVocabularyEntry {
  /** The canonical target the global vocabulary currently maps this source field
   *  to, or null if nothing is mapped for it (e.g. the rejection was outright,
   *  not a losing side of a conflict). Computed live on each list call. */
  selectedTarget: string | null;
}
