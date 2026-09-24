// Field resolver — the piece that actually delivers the cost win.
//
// Priority chain, highest first:
//   1. customVocabulary[clientId]  -> learned, confidence 1.0, never pays AI again
//   2. built-in heuristic          -> format-agnostic aliases / similarity
//   3. unresolved                  -> confidence 0; candidate for AI fallback + suggestion
//
// INTEGRATION POINT: wire this into nexus-engine's existing mapping/plan step. Whatever
// currently decides "heuristic vs AI fallback" should consult resolveFields() first; only
// `unresolved` entries should reach the AI path.

import type { FieldResolution } from "./types.js";
import type { CustomVocabularyStore } from "./custom-vocabulary-store.js";
import { builtinHeuristic } from "./heuristic.js";

export const CUSTOM_VOCAB_CONFIDENCE = 1.0;

export async function resolveFields(
  clientId: string,
  inputFields: string[],
  store: CustomVocabularyStore,
): Promise<FieldResolution[]> {
  // Loaded once per request — this client's vocab only.
  const learned = await store.load(clientId);

  return inputFields.map((inputField): FieldResolution => {
    const hit = learned.get(inputField);
    if (hit) {
      return {
        inputField,
        canonicalField: hit,
        source: "customVocabulary",
        heuristicConfidence: CUSTOM_VOCAB_CONFIDENCE,
      };
    }

    const h = builtinHeuristic(inputField);
    if (h) {
      return {
        inputField,
        canonicalField: h.canonicalField,
        source: "heuristic",
        heuristicConfidence: h.confidence,
      };
    }

    return { inputField, canonicalField: null, source: "unresolved", heuristicConfidence: 0 };
  });
}
