// suggestedMappings — read-only, no persistence.
//
// For every field the resolver couldn't confidently map, surface the closest canonical
// target plus a reason. This is what gets attached to the plan output so a human (or an
// /vocabulary/accept call) can confirm the mapping.
//
// Honest about its own limits: opaque codes like NTGEW won't resemble any canonical English
// leaf, so their suggestion confidence is near zero and the reason says so. That's the
// signal that such fields need an explicit accept/seed rather than auto-similarity.

import type { FieldResolution, SuggestedMapping } from "./types.js";
import { topSimilar } from "./heuristic.js";

const LOW_CONFIDENCE_FLOOR = 0.6;

export function buildSuggestedMappings(resolutions: FieldResolution[]): SuggestedMapping[] {
  return resolutions
    .filter((r) => r.source === "unresolved" || r.heuristicConfidence < LOW_CONFIDENCE_FLOOR)
    .map((r): SuggestedMapping | null => {
      const cand = topSimilar(r.inputField);
      if (!cand) return null;
      const confidence = Number(cand.score.toFixed(2));
      return {
        inputField: r.inputField,
        suggestedCanonical: cand.field,
        confidence,
        reason:
          confidence >= 0.4
            ? `Closest canonical field by name similarity (${Math.round(confidence * 100)}%).`
            : `Opaque field name with no close canonical match (${Math.round(
                confidence * 100,
              )}%); needs explicit mapping.`,
      };
    })
    .filter((s): s is SuggestedMapping => s !== null);
}
