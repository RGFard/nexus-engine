/**
 * hasUnmappedRequired gate — correctness tests.
 *
 * The gate must only count a required field when its ENTIRE ancestor chain in
 * the target schema is required. Nested-in-optional-parent fields (customs,
 * weight, metadata, trackingReferences and their descendants) must never trigger
 * the AI fallback when the payload doesn't include those optional sections.
 *
 * Before the fix the gate counted 20–23 "required" fields for typical payloads,
 * firing AI on every request once an API key is present. After the fix:
 *   - A complete payload (origin + destination + packages) → 0 unmapped → no AI
 *   - ShipStation (no origin address) → 3 unmapped (origin only, legitimate)
 *   - ERP (no address mappings) → 6 unmapped (address fields only, legitimate)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { AiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { InMemoryVocabularyStore } from "../src/ai/services/custom-vocabulary.store.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { loadJson } from "./helpers/load-schema.js";

/** Instantiates a service whose fake API key proves AI was NOT requested if no error. */
function serviceWithFakeKey(): AiMappingService {
  return new AiMappingService(
    {
      anthropicApiKey: "FAKE_KEY_PROVES_AI_NOT_REQUESTED",
      anthropicModel: "test",
      anthropicMaxTokens: 100,
      mappingEnabled: true,
      aiFallbackEnabled: true,
      aiFallbackThreshold: 0.75,
      autoApplyThreshold: 0.45,
    },
    new InMemoryVocabularyStore(),
  );
}

before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
});

describe("hasUnmappedRequired gate — no false positives on optional parents", () => {
  const requestSchema = () => schemaRegistry.get("shipment", "shipment-create-request")!.schema;

  it("complete payload (origin + destination + packages) stays heuristic — AI not requested", async () => {
    const payload = {
      shipFrom: { line1: "1 Main St", city: "Chicago", countryCode: "US" },
      shipTo: { line1: "2 Oak Ave", city: "New York", countryCode: "US" },
      weight: { value: 2.5, units: "lb" },
    };

    // serviceWithFakeKey() would throw a 401 if AI were requested — not throwing = heuristic
    const plan = await serviceWithFakeKey().generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "Complete"),
      targetSchema: requestSchema(),
      sourceExamplePayload: payload,
    });

    assert.equal(
      plan.metadata?.generationMode,
      "heuristic",
      "complete payload must stay heuristic — AI must not be requested",
    );
    assert.equal(plan.metadata?.aiEnhanced, false);
  });

  it("ShipStation (no origin address) triggers AI only for the 3 real origin fields, not for 17 optional-parent false positives", async () => {
    const payload = await loadJson("tests/fixtures/shipstation-shipment.json");
    // No API key: AI is attempted but silently skipped. We check what the resolver surfaced.
    const svc = new AiMappingService(
      {
        anthropicApiKey: undefined,
        anthropicModel: "test",
        anthropicMaxTokens: 100,
        mappingEnabled: true,
        aiFallbackEnabled: true,
        aiFallbackThreshold: 0.75,
        autoApplyThreshold: 0.45,
      },
      new InMemoryVocabularyStore(),
    );

    const plan = await svc.generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "ShipStation"),
      targetSchema: requestSchema(),
      sourceExamplePayload: payload,
    });

    // requiredFieldSuggestions must only contain /origin/* fields — no customs/weight/metadata
    const suggestedPaths = (plan.requiredFieldSuggestions ?? []).map((s) => s.targetField);
    const nonOriginSuggestions = suggestedPaths.filter((p) => !p.startsWith("/origin/"));

    assert.equal(
      nonOriginSuggestions.length,
      0,
      `Expected only /origin/* suggestions, got extras: ${JSON.stringify(nonOriginSuggestions)}`,
    );
    // 3 origin fields should be suggested
    assert.ok(suggestedPaths.includes("/origin/line1"), "origin/line1 must be suggested");
    assert.ok(suggestedPaths.includes("/origin/city"), "origin/city must be suggested");
    assert.ok(suggestedPaths.includes("/origin/countryCode"), "origin/countryCode must be suggested");
  });

  it("package-only payload (no address fields) surfaces only origin/destination suggestions — not customs/weight/metadata", async () => {
    // Packages-only payload: address fields intentionally absent so origin/* and
    // destination/* are legitimately unmapped. Confirms the gate fires for those and
    // ONLY those — not for the 17 optional-parent false positives.
    const payload = {
      NTGEW: "5.5", GEWEI: "KG", LFIMG: 3, ARKTX: "Widget", MATNR: "WIDGET-001",
    };
    const svc = new AiMappingService(
      {
        anthropicApiKey: undefined,
        anthropicModel: "test",
        anthropicMaxTokens: 100,
        mappingEnabled: true,
        aiFallbackEnabled: true,
        aiFallbackThreshold: 0.75,
        autoApplyThreshold: 0.45,
      },
      new InMemoryVocabularyStore(),
    );

    const plan = await svc.generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "PackageOnly"),
      targetSchema: requestSchema(),
      sourceExamplePayload: payload,
    });

    const suggestedPaths = (plan.requiredFieldSuggestions ?? []).map((s) => s.targetField);

    // Only origin/* and destination/* — nothing from optional parents
    for (const p of suggestedPaths) {
      assert.ok(
        p.startsWith("/origin/") || p.startsWith("/destination/"),
        `Unexpected suggestion: ${p} — only origin/* and destination/* expected`,
      );
    }

    // All 6 address fields must be flagged as unmapped required
    const expected = [
      "/origin/line1", "/origin/city", "/origin/countryCode",
      "/destination/line1", "/destination/city", "/destination/countryCode",
    ];
    for (const ep of expected) {
      assert.ok(suggestedPaths.includes(ep), `${ep} must be in requiredFieldSuggestions`);
    }
  });

  it("full ERP payload (packages + addresses) maps to valid:true with 0 unmapped required — AI not requested", async () => {
    // With all SAP fields in EXPLICIT_PATH_MAPPINGS, the gate sees 0 unmapped required.
    const payload = {
      NTGEW: "5.5", GEWEI: "KG", LFIMG: 3, ARKTX: "Widget", MATNR: "WIDGET-001",
      STRAS_S: "123 Warehouse Rd", ORT01_S: "Chicago", LAND1_S: "US",
      STRAS_E: "456 Customer Ave", ORT01_E: "New York", LAND1_E: "US",
    };

    // Fake key: proves AI was not requested if no 401 thrown
    const plan = await serviceWithFakeKey().generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "ERPFull"),
      targetSchema: requestSchema(),
      sourceExamplePayload: payload,
    });

    assert.equal(plan.metadata?.generationMode, "heuristic", "full ERP must stay heuristic");
    assert.equal(plan.metadata?.aiEnhanced, false);
    assert.equal(
      (plan.requiredFieldSuggestions ?? []).length,
      0,
      "full ERP must have zero required suggestions",
    );
  });
});
