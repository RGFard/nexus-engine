// Built-in heuristic — the priority tier *below* customVocabulary.
//
// This is the format-agnostic layer: common English-ish field names that map cleanly to
// canonical fields without needing AI. Opaque codes (SAP's NTGEW, LFIMG, ...) deliberately
// DON'T live here — they score 0 until learned, which is exactly the cost leak Step 3 closes.

import { CANONICAL_FIELDS } from "./canonical-schema.js";

const ALIASES: Record<string, string> = {
  weight: "packages.weight",
  netweight: "packages.weight",
  weightunit: "packages.weightUnit",
  qty: "packages.quantity",
  quantity: "packages.quantity",
  itemdescription: "packages.itemDescription",
  description: "packages.itemDescription",
  sku: "packages.materialNumber",
  materialnumber: "packages.materialNumber",
  trackingnumber: "trackingNumber",
  tracking: "trackingNumber",
  ordernumber: "orderNumber",
  orderid: "orderNumber",
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Resolution-grade heuristic. Returns null when nothing clears the confidence floor. */
export function builtinHeuristic(inputField: string): { canonicalField: string; confidence: number } | null {
  const key = norm(inputField);
  if (ALIASES[key]) return { canonicalField: ALIASES[key], confidence: 0.95 };

  const best = topSimilar(inputField);
  if (best && best.score >= 0.6) {
    return { canonicalField: best.field, confidence: round2(best.score) };
  }
  return null;
}

/**
 * Best canonical candidate by name similarity, regardless of how weak. Used by the
 * suggestion engine, which wants a best-guess even for fields the resolver gave up on.
 */
export function topSimilar(inputField: string): { field: string; score: number } | null {
  const key = norm(inputField);
  if (!key) return null;
  let best: { field: string; score: number } | null = null;
  for (const field of CANONICAL_FIELDS) {
    const leaf = norm(field.split(".").pop()!);
    const score = diceCoefficient(key, leaf);
    if (!best || score > best.score) best = { field, score };
  }
  return best;
}

// --- Dice coefficient over character bigrams: cheap, dependency-free string similarity. ---
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of aB) {
    const other = bB.get(bg) ?? 0;
    overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

const round2 = (n: number): number => Number(n.toFixed(2));
