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
