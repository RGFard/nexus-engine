/**
 * ERP (SAP) vocabulary seed.
 *
 * Seeds the known finite set of SAP field→canonical mappings for the ERP client
 * so they resolve from customVocabulary at confidence 1.0 immediately, without
 * needing an AI call first.
 *
 * SAP field meanings:
 *   NTGEW = Nettogewicht (net weight)         → /packages[]/weight/value
 *   GEWEI = Gewichtseinheit (weight unit)      → /packages[]/weight/unit
 *   LFIMG = Liefermenge (delivery quantity)    → /packages[]/quantity
 *   ARKTX = Artikelkurztext (article text)     → /packages[]/description
 *   MATNR = Materialnummer (material number)   → /packages[]/sku
 *
 * NOTE: EXPLICIT_PATH_MAPPINGS in logistics-synonyms.ts already covers these
 * fields in the heuristic layer. This seed applies if you want guaranteed
 * confidence 1.0 for a named ERP client, bypassing heuristic scoring entirely.
 *
 * Usage (run once, not at startup):
 *   tsx src/ai/seeds/erp-vocabulary.seed.ts
 *
 * ⚠  Before running, confirm with the team whether this seed IS the primary
 * ERP fix or whether the gateway-side ERP alias fix should land first.
 */

import { JsonFileVocabularyStore, InMemoryVocabularyStore } from "../services/custom-vocabulary.store.js";
import type { VocabularyEntry } from "../models/vocabulary.types.js";

export const ERP_CLIENT_ID = "erp-client";

export const ERP_SEED: VocabularyEntry[] = [
  { inputField: "NTGEW", canonicalField: "/packages[]/weight/value" },
  { inputField: "GEWEI", canonicalField: "/packages[]/weight/unit" },
  { inputField: "LFIMG", canonicalField: "/packages[]/quantity" },
  { inputField: "ARKTX", canonicalField: "/packages[]/description" },
  { inputField: "MATNR", canonicalField: "/packages[]/sku" },
];

// Run as a script: tsx src/ai/seeds/erp-vocabulary.seed.ts
if (process.argv[1]?.endsWith("erp-vocabulary.seed.ts") || process.argv[1]?.endsWith("erp-vocabulary.seed.js")) {
  const vocabDir = process.env.VOCAB_DIR;
  const store = vocabDir
    ? new JsonFileVocabularyStore(vocabDir)
    : new InMemoryVocabularyStore();

  store.accept(ERP_CLIENT_ID, ERP_SEED).then((accepted) => {
    console.log(`Seeded ${accepted.length} ERP vocabulary entries for client '${ERP_CLIENT_ID}':`);
    for (const e of accepted) {
      console.log(`  ${e.inputField} → ${e.canonicalField}`);
    }
    if (!vocabDir) {
      console.warn("VOCAB_DIR not set — entries were written to in-memory store only (lost on exit).");
    }
  });
}
