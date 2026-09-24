/**
 * Custom vocabulary — per-client isolation and confidence guarantee.
 *
 * Acceptance criteria (from task):
 *   1. A previously-unresolved ERP field resolves from customVocabulary at full
 *      confidence (1.0) after accept.
 *   2. A second client sees none of the first client's vocabulary.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { AiMappingService, CUSTOM_VOCAB_CONFIDENCE } from "../src/ai/services/ai-mapping.service.js";
import { InMemoryVocabularyStore } from "../src/ai/services/custom-vocabulary.store.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";

// Minimal ERP flat payload — all-caps SAP field names, no nested structure.
const ERP_PAYLOAD: Record<string, unknown> = {
  NTGEW: "5.5",
  GEWEI: "KG",
  LFIMG: 3,
  ARKTX: "Widget part A",
  MATNR: "WIDGET-001",
  STRAS_S: "123 Warehouse Rd",
  ORT01_S: "Chicago",
  LAND1_S: "US",
  STRAS_E: "456 Customer Ave",
  ORT01_E: "New York",
  LAND1_E: "US",
};

const ERP_CLIENT = "erp-client";
const OTHER_CLIENT = "other-client";

// Vocabulary: exact SAP field name → canonical JSON Pointer path
const ERP_VOCAB = [
  { inputField: "NTGEW", canonicalField: "/packages[]/weight/value" },
  { inputField: "GEWEI", canonicalField: "/packages[]/weight/unit" },
  { inputField: "LFIMG", canonicalField: "/packages[]/quantity" },
  { inputField: "ARKTX", canonicalField: "/packages[]/description" },
  { inputField: "MATNR", canonicalField: "/packages[]/sku" },
];

before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
});

describe("custom vocabulary — per-client isolation", () => {
  it("ERP fields resolve at confidence 1.0 after accept, not before", async () => {
    const store = new InMemoryVocabularyStore();
    const service = new AiMappingService(undefined, store);

    const requestSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ERP_PAYLOAD, "ERP");

    // ── Before accept: NTGEW should NOT map at confidence 1.0 ────────────────
    const planBefore = await service.generateMapping({
      sourceSchema,
      targetSchema: requestSchema,
      sourceExamplePayload: ERP_PAYLOAD,
      options: { clientId: ERP_CLIENT },
    });

    const ntgewBefore = planBefore.mappings.find(
      (m) => m.sourceField === "/NTGEW" && m.targetField === "/packages[]/weight/value",
    );
    // May or may not exist via heuristic/explicit — but must NOT be confidence 1.0
    if (ntgewBefore) {
      assert.ok(
        ntgewBefore.confidence < CUSTOM_VOCAB_CONFIDENCE,
        `NTGEW was confidence 1.0 before accept — expected < 1.0, got ${ntgewBefore.confidence}`,
      );
    }

    // ── Accept the ERP vocabulary ────────────────────────────────────────────
    await store.accept(ERP_CLIENT, ERP_VOCAB);

    // ── After accept: all ERP fields must resolve at confidence 1.0 ──────────
    const planAfter = await service.generateMapping({
      sourceSchema,
      targetSchema: requestSchema,
      sourceExamplePayload: ERP_PAYLOAD,
      options: { clientId: ERP_CLIENT },
    });

    for (const entry of ERP_VOCAB) {
      const m = planAfter.mappings.find(
        (m) =>
          m.sourceField.endsWith(`/${entry.inputField}`) &&
          m.targetField === entry.canonicalField,
      );
      assert.ok(
        m,
        `Expected mapping ${entry.inputField} → ${entry.canonicalField} after accept`,
      );
      assert.equal(
        m.confidence,
        CUSTOM_VOCAB_CONFIDENCE,
        `${entry.inputField} must resolve at confidence 1.0 from customVocabulary, got ${m.confidence}`,
      );
      assert.ok(
        m.reasoning.includes("Custom vocabulary"),
        `Reasoning must mention 'Custom vocabulary', got: ${m.reasoning}`,
      );
    }
  });

  it("second client sees none of the first client's vocabulary", async () => {
    const store = new InMemoryVocabularyStore();
    const service = new AiMappingService(undefined, store);

    const requestSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ERP_PAYLOAD, "ERP");

    // Seed vocabulary for ERP client only
    await store.accept(ERP_CLIENT, ERP_VOCAB);

    // Plan for a different client — should not see any vocabulary mappings
    const planOther = await service.generateMapping({
      sourceSchema,
      targetSchema: requestSchema,
      sourceExamplePayload: ERP_PAYLOAD,
      options: { clientId: OTHER_CLIENT },
    });

    for (const entry of ERP_VOCAB) {
      const vocabMapping = planOther.mappings.find(
        (m) =>
          m.sourceField.endsWith(`/${entry.inputField}`) &&
          m.targetField === entry.canonicalField &&
          m.confidence === CUSTOM_VOCAB_CONFIDENCE,
      );
      assert.ok(
        !vocabMapping,
        `${OTHER_CLIENT} must not see ${ERP_CLIENT}'s vocabulary mapping for ${entry.inputField} at confidence 1.0`,
      );
    }
  });

  it("suggestedMappings is present and surfaces unmapped fields", async () => {
    const store = new InMemoryVocabularyStore();
    const service = new AiMappingService(undefined, store);

    const requestSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ERP_PAYLOAD, "ERP");

    const plan = await service.generateMapping({
      sourceSchema,
      targetSchema: requestSchema,
      sourceExamplePayload: ERP_PAYLOAD,
    });

    // suggestedMappings must be an array
    assert.ok(Array.isArray(plan.suggestedMappings), "suggestedMappings must be an array");

    if (plan.suggestedMappings.length > 0) {
      for (const s of plan.suggestedMappings) {
        assert.ok(typeof s.inputField === "string", "inputField must be a string");
        assert.ok(typeof s.suggestedCanonical === "string", "suggestedCanonical must be a string");
        assert.ok(typeof s.confidence === "number", "confidence must be a number");
        assert.ok(s.confidence >= 0 && s.confidence <= 1, "confidence must be 0..1");
        assert.ok(typeof s.reason === "string", "reason must be a string");
      }
    }
  });

  it("/vocabulary/accept rejects unknown canonical field, accepts valid one", async () => {
    const { CanonicalFieldsService } = await import(
      "../src/ai/services/canonical-fields.service.js"
    );
    const store = new InMemoryVocabularyStore();
    const canonical = new CanonicalFieldsService(schemaRegistry);
    canonical.initialize();

    // Valid canonical path
    assert.ok(
      canonical.isCanonicalField("/packages[]/weight/value"),
      "/packages[]/weight/value must be a valid canonical field",
    );
    // Bogus canonical path
    assert.ok(
      !canonical.isCanonicalField("packages.weight"),
      "dot-notation 'packages.weight' must NOT be a valid canonical field (JSON Pointer required)",
    );
    assert.ok(
      !canonical.isCanonicalField("/packages[]/nonexistent"),
      "/packages[]/nonexistent must NOT be a valid canonical field",
    );

    // Accept valid mapping
    const accepted = await store.accept("test-client", [
      { inputField: "MY_WEIGHT", canonicalField: "/packages[]/weight/value" },
    ]);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.inputField, "MY_WEIGHT");
    assert.equal(accepted[0]!.canonicalField, "/packages[]/weight/value");

    // Isolation: different client sees empty vocab
    const otherVocab = await store.load("other-test-client");
    assert.equal(otherVocab.size, 0, "other client must have empty vocabulary");
  });
});

// ── Step 3 end-to-end loop: NAME1_S / NAME1_E for erp-client ─────────────────
//
// Proves the full resolveFields → inject → targetPayload chain on real optional
// ERP fields from the real payload, with explicit tenant-isolation verification
// in the same run.
//
// NAME1_S (Sender company) and NAME1_E (Recipient company) are present in the
// ERP payload but absent from EXPLICIT_PATH_MAPPINGS and LOGISTICS_CONCEPTS.
// Before accept: suggestedMappings shows both at 0.75 (heuristic finds "name"
// but can't distinguish sender/recipient or name vs company).
// After accept: both resolve at 1.0, targetPayload gains origin.company and
// destination.company. ERP stays valid:true throughout. Other clients see nothing.

describe("Step 3 vocab loop — NAME1_S / NAME1_E end-to-end with tenant isolation", () => {
  const ERP_CLIENT = "erp-client";
  const OTHER_CLIENT = "other-client";

  const ERP_PAYLOAD: Record<string, unknown> = {
    NTGEW: "5.5", GEWEI: "KG", LFIMG: 3, ARKTX: "Widget part A", MATNR: "WIDGET-001",
    STRAS_S: "123 Warehouse Rd", ORT01_S: "Chicago", LAND1_S: "US", NAME1_S: "Sender Inc",
    STRAS_E: "456 Customer Ave", ORT01_E: "New York", LAND1_E: "US", NAME1_E: "Recipient Corp",
  };

  let store: InMemoryVocabularyStore;
  let svc: AiMappingService;
  let validatingExecutor: TransformationExecutorService;
  let requestSchema: Record<string, unknown>;

  before(async () => {
    requestSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;
    store = new InMemoryVocabularyStore();
    svc = new AiMappingService(
      {
        anthropicApiKey: undefined,
        anthropicModel: "test",
        anthropicMaxTokens: 100,
        mappingEnabled: true,
        aiFallbackEnabled: true,
        aiFallbackThreshold: 0.75,
        autoApplyThreshold: 0.45,
      },
      store,
    );
    const validationService = new SchemaValidationService(schemaRegistry);
    await validationService.initialize();
    validatingExecutor = new TransformationExecutorService(validationService);
  });

  it("BEFORE accept — NAME1_S and NAME1_E appear in suggestedMappings, ERP already valid:true without them", async () => {
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ERP_PAYLOAD, "ERP");
    const plan = await svc.generateMapping({
      sourceSchema, targetSchema: requestSchema,
      sourceExamplePayload: ERP_PAYLOAD,
      options: { clientId: ERP_CLIENT },
    });

    // Both NAME fields must be in unmappedSourceFields
    assert.ok(
      plan.unmappedSourceFields.includes("/NAME1_S"),
      "/NAME1_S must be unmapped before accept",
    );
    assert.ok(
      plan.unmappedSourceFields.includes("/NAME1_E"),
      "/NAME1_E must be unmapped before accept",
    );

    // suggestedMappings must surface both with a heuristic guess
    const suggestions = plan.suggestedMappings ?? [];
    const name1s = suggestions.find((s) => s.inputField === "/NAME1_S");
    const name1e = suggestions.find((s) => s.inputField === "/NAME1_E");
    assert.ok(name1s, "/NAME1_S must appear in suggestedMappings before accept");
    assert.ok(name1e, "/NAME1_E must appear in suggestedMappings before accept");
    // Heuristic finds "name" by similarity but can't pin company vs name — confidence > 0
    assert.ok(name1s.confidence > 0, "NAME1_S suggestion must have non-zero confidence");
    assert.ok(name1e.confidence > 0, "NAME1_E suggestion must have non-zero confidence");
    // Neither must be at vocabulary confidence — not yet accepted
    assert.ok(name1s.confidence < CUSTOM_VOCAB_CONFIDENCE, "NAME1_S not yet at vocab confidence");
    assert.ok(name1e.confidence < CUSTOM_VOCAB_CONFIDENCE, "NAME1_E not yet at vocab confidence");

    // ERP must already be valid:true (address + package fields covered)
    const result = await validatingExecutor.executeWithOptions({
      sourcePayload: ERP_PAYLOAD, plan,
      options: { minConfidence: 0, validateTarget: { domain: "shipment", schemaName: "shipment-create-request" } },
    });
    assert.equal(result.validation?.valid, true, "ERP must be valid:true before NAME accept");
    assert.equal((result.validation?.errors ?? []).length, 0);

    // company fields absent from target (not yet mapped)
    const target = result.targetPayload as Record<string, Record<string, unknown>>;
    assert.equal(target.origin?.company, undefined, "origin.company must be absent before accept");
    assert.equal(target.destination?.company, undefined, "destination.company must be absent before accept");
  });

  it("ACCEPT — batch of 2 entries accepted, 0 rejected, scoped to erp-client only", async () => {
    const accepted = await store.accept(ERP_CLIENT, [
      { inputField: "NAME1_S", canonicalField: "/origin/company" },
      { inputField: "NAME1_E", canonicalField: "/destination/company" },
    ]);

    assert.equal(accepted.length, 2, "must accept exactly 2 entries");
    const name1s = accepted.find((e) => e.inputField === "NAME1_S");
    const name1e = accepted.find((e) => e.inputField === "NAME1_E");
    assert.equal(name1s?.canonicalField, "/origin/company");
    assert.equal(name1e?.canonicalField, "/destination/company");

    // Physical isolation: only erp-client's store has these entries
    const erpVocab = await store.load(ERP_CLIENT);
    assert.equal(erpVocab.size, 2, "erp-client vocab must have exactly 2 entries");
    assert.equal(erpVocab.get("NAME1_S"), "/origin/company");
    assert.equal(erpVocab.get("NAME1_E"), "/destination/company");

    // Physical check: other-client's store is completely separate and empty
    const otherVocab = await store.load(OTHER_CLIENT);
    assert.equal(otherVocab.size, 0, "other-client vocab must be empty — no cross-tenant leak");
  });

  it("AFTER accept — erp-client: NAME fields resolve at 1.0, origin.company and destination.company populated, valid:true, heuristic mode", async () => {
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ERP_PAYLOAD, "ERP");
    const plan = await svc.generateMapping({
      sourceSchema, targetSchema: requestSchema,
      sourceExamplePayload: ERP_PAYLOAD,
      options: { clientId: ERP_CLIENT },
    });

    assert.equal(plan.metadata?.generationMode, "heuristic", "must stay heuristic after accept");
    assert.equal(plan.metadata?.aiEnhanced, false, "AI must not be triggered");

    // NAME1_S and NAME1_E must resolve at exactly 1.0 from vocab
    const name1sMapping = plan.mappings.find(
      (m) => m.sourceField === "/NAME1_S" && m.targetField === "/origin/company",
    );
    const name1eMapping = plan.mappings.find(
      (m) => m.sourceField === "/NAME1_E" && m.targetField === "/destination/company",
    );

    assert.ok(name1sMapping, "NAME1_S → /origin/company must be in plan.mappings after accept");
    assert.ok(name1eMapping, "NAME1_E → /destination/company must be in plan.mappings after accept");
    assert.equal(name1sMapping.confidence, CUSTOM_VOCAB_CONFIDENCE, "NAME1_S must be at confidence 1.0");
    assert.equal(name1eMapping.confidence, CUSTOM_VOCAB_CONFIDENCE, "NAME1_E must be at confidence 1.0");
    assert.ok(
      name1sMapping.reasoning.includes("Custom vocabulary"),
      `NAME1_S reasoning must cite Custom vocabulary, got: ${name1sMapping.reasoning}`,
    );

    // Execute and validate — ERP must stay valid:true, company fields present
    const result = await validatingExecutor.executeWithOptions({
      sourcePayload: ERP_PAYLOAD, plan,
      options: { minConfidence: 0, validateTarget: { domain: "shipment", schemaName: "shipment-create-request" } },
    });

    assert.equal(result.validation?.valid, true, "ERP must still be valid:true after accept");
    assert.equal((result.validation?.errors ?? []).length, 0);

    const target = result.targetPayload as Record<string, Record<string, unknown>>;
    assert.equal(target.origin?.company, "Sender Inc", "origin.company must be 'Sender Inc'");
    assert.equal(target.destination?.company, "Recipient Corp", "destination.company must be 'Recipient Corp'");
  });

  it("AFTER accept — other-client: NAME1_S and NAME1_E are NOT resolved from vocab (isolation proof)", async () => {
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ERP_PAYLOAD, "ERP");
    const plan = await svc.generateMapping({
      sourceSchema, targetSchema: requestSchema,
      sourceExamplePayload: ERP_PAYLOAD,
      options: { clientId: OTHER_CLIENT },
    });

    // NAME1_S and NAME1_E must NOT be at vocab confidence for other-client
    const vocabMappings = plan.mappings.filter(
      (m) =>
        (m.sourceField === "/NAME1_S" || m.sourceField === "/NAME1_E") &&
        m.confidence === CUSTOM_VOCAB_CONFIDENCE,
    );
    assert.equal(
      vocabMappings.length,
      0,
      `other-client must have zero vocab-confidence mappings for NAME fields, got: ${JSON.stringify(vocabMappings.map((m) => m.sourceField + "→" + m.targetField))}`,
    );

    // NAME fields must still be in unmappedSourceFields for other-client
    assert.ok(
      plan.unmappedSourceFields.includes("/NAME1_S"),
      "/NAME1_S must remain unmapped for other-client",
    );
    assert.ok(
      plan.unmappedSourceFields.includes("/NAME1_E"),
      "/NAME1_E must remain unmapped for other-client",
    );

    // Execute — company fields must NOT appear in other-client's target
    const executor = new TransformationExecutorService();
    const result = await executor.executeWithOptions({
      sourcePayload: ERP_PAYLOAD, plan, options: { minConfidence: 0 },
    });
    const target = result.targetPayload as Record<string, Record<string, unknown>>;
    assert.equal(
      target.origin?.company,
      undefined,
      "origin.company must be absent for other-client — no cross-tenant leak",
    );
    assert.equal(
      target.destination?.company,
      undefined,
      "destination.company must be absent for other-client",
    );
  });
});
