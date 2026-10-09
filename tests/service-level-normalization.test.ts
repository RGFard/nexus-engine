/**
 * /serviceLevel enum normalization.
 *
 * /serviceLevel has a fixed canonical enum (economy|standard|express|overnight|
 * same_day|null), but every carrier exposes it as its own product/service code
 * instead (DHL "P", UPS "03", FedEx "FEDEX_GROUND", ...). The service_level
 * concept's canonicalPaths list /serviceLevel alongside /carrier/serviceCode, and
 * whichever one scores higher for a given source field wins -- a source field
 * literally named "serviceLevel" beats /carrier/serviceCode on the exact-name
 * tie-break. Before this fix, that mapping carried a bare "direct" transform, so
 * the raw carrier code shipped straight into an enum field it could never satisfy
 * and /ai/normalize's own validation step failed on /serviceLevel for any carrier
 * whose code wasn't already one of the five canonical words.
 *
 * enforceServiceLevelNormalization forces a normalize:serviceLevel step onto any
 * mapping landing on /serviceLevel, mirroring how enforceContentsTypeNormalization
 * already does this for /customs/contentsType.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { AiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { InMemoryVocabularyStore } from "../src/ai/services/custom-vocabulary.store.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { applyTransformationSteps } from "../src/ai/services/transformation-engine.js";

/** Heuristic-only service: a fake API key proves AI was never needed for these cases. */
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

let validator: SchemaValidationService;

before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
  validator = new SchemaValidationService(schemaRegistry);
  await validator.initialize();
});

const requestSchema = () => schemaRegistry.get("shipment", "shipment-create-request")!.schema;

describe("normalize:serviceLevel transformation step", () => {
  it("maps known carrier codes to the canonical enum", () => {
    const ctx = { sourcePayload: {}, mapping: {} as never };
    assert.equal(applyTransformationSteps("P", "normalize:serviceLevel", ctx), "express"); // DHL
    assert.equal(applyTransformationSteps("K", "normalize:serviceLevel", ctx), "overnight"); // DHL
    assert.equal(applyTransformationSteps("03", "normalize:serviceLevel", ctx), "standard"); // UPS Ground
    assert.equal(applyTransformationSteps("01", "normalize:serviceLevel", ctx), "overnight"); // UPS Next Day Air
    assert.equal(applyTransformationSteps("FEDEX_GROUND", "normalize:serviceLevel", ctx), "standard");
    assert.equal(applyTransformationSteps("PRIORITY_OVERNIGHT", "normalize:serviceLevel", ctx), "overnight");
    assert.equal(applyTransformationSteps("Ground", "normalize:serviceLevel", ctx), "standard"); // case-insensitive
  });

  it("passes the canonical words through unchanged", () => {
    const ctx = { sourcePayload: {}, mapping: {} as never };
    for (const word of ["economy", "standard", "express", "overnight", "same_day"]) {
      assert.equal(applyTransformationSteps(word, "normalize:serviceLevel", ctx), word);
    }
  });

  it("falls back to null for an unrecognized code rather than failing the enum", () => {
    const ctx = { sourcePayload: {}, mapping: {} as never };
    assert.equal(applyTransformationSteps("SOME_NEW_CARRIER_CODE", "normalize:serviceLevel", ctx), null);
    assert.equal(applyTransformationSteps(null, "normalize:serviceLevel", ctx), null);
  });
});

describe("enforceServiceLevelNormalization -- end to end", () => {
  it("forces normalize:serviceLevel when a source field named serviceLevel wins the /serviceLevel mapping", async () => {
    const svc = serviceWithFakeKey();
    const payload = {
      serviceLevel: "P", // DHL's raw product code, arriving under the canonical field name
      origin: { city: "Berlin", countryCode: "DE", line1: "Hauptstrasse 5", postalCode: "10115" },
      destination: { city: "New York", countryCode: "US", line1: "456 Customer Ave", postalCode: "10001" },
      packages: [{ weight: { value: 2.5, unit: "kg" } }],
    };

    const plan = await svc.generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "DHL"),
      targetSchema: requestSchema(),
      sourceExamplePayload: payload,
    });

    const svcMapping = plan.mappings.find((m) => m.targetField === "/serviceLevel");
    assert.ok(svcMapping, "expected a mapping onto /serviceLevel");
    assert.ok(
      svcMapping!.transformation.includes("normalize:serviceLevel"),
      `expected normalize:serviceLevel in "${svcMapping!.transformation}"`,
    );

    const executor = new TransformationExecutorService();
    const result = await executor.execute({ sourcePayload: payload, plan });
    assert.equal(result.targetPayload.serviceLevel, "express");

    const validation = validator.validate("shipment", "shipment-create-request", result.targetPayload);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });

  it("still validates when the carrier code has no known mapping (defaults to null)", async () => {
    const svc = serviceWithFakeKey();
    const payload = {
      serviceLevel: "WPX-99-UNKNOWN",
      origin: { city: "Berlin", countryCode: "DE", line1: "Hauptstrasse 5", postalCode: "10115" },
      destination: { city: "New York", countryCode: "US", line1: "456 Customer Ave", postalCode: "10001" },
      packages: [{ weight: { value: 2.5, unit: "kg" } }],
    };

    const plan = await svc.generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "DHL"),
      targetSchema: requestSchema(),
      sourceExamplePayload: payload,
    });

    const executor = new TransformationExecutorService();
    const result = await executor.execute({ sourcePayload: payload, plan });
    assert.equal(result.targetPayload.serviceLevel, null);

    const validation = validator.validate("shipment", "shipment-create-request", result.targetPayload);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });
});
