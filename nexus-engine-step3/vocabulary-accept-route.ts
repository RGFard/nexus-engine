// POST /vocabulary/accept
//
// Takes the mappings a caller chose to accept and persists them into that client's vocab.
// Validates the canonical *target* (must be a real canonical field); never validates the
// input side. Per-client isolation is inherited from the store (everything keyed on clientId).
//
// The core is a pure function so it's portable across HTTP frameworks; an Express-style
// adapter is provided. INTEGRATION POINT: mount expressAcceptHandler at POST /vocabulary/accept,
// or call acceptVocabulary() directly from whatever router nexus-engine uses.

import type { CustomVocabularyStore } from "./custom-vocabulary-store.js";
import { isCanonicalField } from "./canonical-schema.js";
import type { VocabularyEntry } from "./types.js";

export interface AcceptRequest {
  clientId: string;
  acceptedMappings: Array<{ inputField: string; canonicalField: string }>;
}

export interface AcceptResult {
  accepted: VocabularyEntry[];
  rejected: Array<{ inputField: string; canonicalField: string; reason: string }>;
}

export async function acceptVocabulary(
  req: AcceptRequest,
  store: CustomVocabularyStore,
): Promise<AcceptResult> {
  if (!req || !req.clientId) throw new Error("clientId is required");
  if (!Array.isArray(req.acceptedMappings)) throw new Error("acceptedMappings must be an array");

  const valid: VocabularyEntry[] = [];
  const rejected: AcceptResult["rejected"] = [];

  for (const m of req.acceptedMappings) {
    if (!m || !m.inputField || !m.canonicalField) {
      rejected.push({
        inputField: m?.inputField ?? "",
        canonicalField: m?.canonicalField ?? "",
        reason: "inputField and canonicalField are both required",
      });
      continue;
    }
    if (!isCanonicalField(m.canonicalField)) {
      rejected.push({
        inputField: m.inputField,
        canonicalField: m.canonicalField,
        reason: `'${m.canonicalField}' is not a known canonical field`,
      });
      continue;
    }
    valid.push({ inputField: m.inputField, canonicalField: m.canonicalField });
  }

  const accepted = valid.length ? await store.accept(req.clientId, valid) : [];
  return { accepted, rejected };
}

// --- Minimal Express-style adapter (no express dependency required) ---

interface MinimalReq {
  body: AcceptRequest;
}
interface MinimalRes {
  status(code: number): MinimalRes;
  json(body: unknown): void;
}

export function expressAcceptHandler(store: CustomVocabularyStore) {
  return async (req: MinimalReq, res: MinimalRes): Promise<void> => {
    try {
      const result = await acceptVocabulary(req.body, store);
      // 400 only if everything was rejected and nothing landed; otherwise 200 with a partial report.
      const code = result.accepted.length === 0 && result.rejected.length > 0 ? 400 : 200;
      res.status(code).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };
}
