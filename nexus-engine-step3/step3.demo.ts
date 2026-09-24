// Runnable demo: proves the Step 3 loop closes and tenant isolation holds.
// Run with:  npx tsx src/step3.demo.ts

import { InMemoryVocabularyStore } from "./custom-vocabulary-store.js";
import { resolveFields } from "./resolver.js";
import { buildSuggestedMappings } from "./suggestions.js";
import { acceptVocabulary } from "./vocabulary-accept-route.js";
import { ERP_SEED } from "./seed-erp-vocabulary.js";

const ERP_FIELDS = ["NTGEW", "GEWEI", "LFIMG", "ARKTX", "MATNR"];

function printResolutions(label: string, rows: Awaited<ReturnType<typeof resolveFields>>) {
  console.log(`\n${label}`);
  for (const r of rows) {
    console.log(
      `  ${r.inputField.padEnd(8)} -> ${(r.canonicalField ?? "(none)").padEnd(24)} ` +
        `[${r.source}, conf=${r.heuristicConfidence}]`,
    );
  }
}

async function main() {
  const store = new InMemoryVocabularyStore();
  const ERP = "client_erp";

  // --- 1. Cold resolve: nothing learned yet. Every ERP field is unresolved -> would pay AI. ---
  const cold = await resolveFields(ERP, ERP_FIELDS, store);
  printResolutions("COLD (before learning) — every field pays AI:", cold);

  const payingAiBefore = cold.filter((r) => r.source === "unresolved").length;
  console.log(`  => ${payingAiBefore}/${ERP_FIELDS.length} fields fall through to AI`);

  // --- 2. suggestedMappings the plan would surface for those unresolved fields. ---
  const suggestions = buildSuggestedMappings(cold);
  console.log("\nsuggestedMappings (read-only, surfaced on the plan):");
  for (const s of suggestions) {
    console.log(`  ${s.inputField.padEnd(8)} ~> ${s.suggestedCanonical.padEnd(24)} (conf=${s.confidence}) ${s.reason}`);
  }

  // --- 3. Accept the correct ERP mappings via POST /vocabulary/accept. ---
  const result = await acceptVocabulary({ clientId: ERP, acceptedMappings: ERP_SEED }, store);
  console.log(`\n/vocabulary/accept: persisted ${result.accepted.length}, rejected ${result.rejected.length}`);

  // Show validation rejecting a bogus canonical target.
  const bad = await acceptVocabulary(
    { clientId: ERP, acceptedMappings: [{ inputField: "ZZZZ", canonicalField: "packages.notARealField" }] },
    store,
  );
  console.log(`  bogus-target check: rejected ${bad.rejected.length} -> ${bad.rejected[0]?.reason}`);

  // --- 4. Warm resolve: same fields now come from customVocabulary at confidence 1.0. ---
  const warm = await resolveFields(ERP, ERP_FIELDS, store);
  printResolutions("WARM (after accept) — learned, no AI cost:", warm);
  const payingAiAfter = warm.filter((r) => r.source === "unresolved").length;
  console.log(`  => ${payingAiAfter}/${ERP_FIELDS.length} fields fall through to AI`);

  // --- 5. Tenant isolation: a different client learned nothing, so it's still cold. ---
  const other = await resolveFields("client_other", ERP_FIELDS, store);
  const otherLearned = other.filter((r) => r.source === "customVocabulary").length;
  console.log(`\nIsolation check — client_other sees ${otherLearned} learned mappings (expected 0).`);

  const ok =
    payingAiBefore === ERP_FIELDS.length &&
    payingAiAfter === 0 &&
    bad.rejected.length === 1 &&
    otherLearned === 0;
  console.log(`\n${ok ? "PASS" : "FAIL"}: loop closes (5/5 -> 0/5), bad target rejected, tenants isolated.`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
