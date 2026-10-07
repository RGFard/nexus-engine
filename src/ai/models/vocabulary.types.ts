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
}

/** Input to LearnedVocabularyStore.recordPending — store fills in id/timestamps. */
export type PendingVocabularyInput = Omit<
  PendingVocabularyEntry,
  "id" | "firstSeenAt" | "lastSeenAt" | "seenCount"
>;
