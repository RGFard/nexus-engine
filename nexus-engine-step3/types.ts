// Shared types for Step 3 — auto-learning vocabulary.

export type CanonicalField = string; // canonical leaf path, e.g. "packages.weight"

export type ResolutionSource = "customVocabulary" | "heuristic" | "unresolved";

export interface FieldResolution {
  inputField: string;
  canonicalField: CanonicalField | null;
  source: ResolutionSource;
  /**
   * 0..1. A resolution from customVocabulary scores at CUSTOM_VOCAB_CONFIDENCE (1.0),
   * which is the whole point of Step 3: once learned, a field never falls through to AI again.
   * `unresolved` is always 0 — that's the field that currently pays AI cost.
   */
  heuristicConfidence: number;
}

export interface SuggestedMapping {
  inputField: string;
  suggestedCanonical: CanonicalField;
  confidence: number; // 0..1
  reason: string;
}

export interface VocabularyEntry {
  inputField: string;
  canonicalField: CanonicalField;
}
