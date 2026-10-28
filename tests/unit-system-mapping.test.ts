import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { aiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { fillUnitsFromSystem } from "../src/ai/utils/weight-unit-inheritance.js";
import { loadJson } from "./helpers/load-schema.js";

// DHL MyDHL sends bare package weights and dimensions and one unit system for the shipment.

describe("fillUnitsFromSystem", () => {
  it("fills kg and cm for metric, only where a unit is missing", () => {
    const p: Record<string, any> = {
      extensions: { unitSystem: "metric" },
      packages: [{ weight: { value: 2 }, dimensions: { length: 3 } }, { weight: { value: 1, unit: "lb" } }],
    };
    assert.equal(fillUnitsFromSystem(p), 2);
    assert.deepEqual(p.packages[0], { weight: { value: 2, unit: "kg" }, dimensions: { length: 3, unit: "cm" } });
    assert.deepEqual(p.packages[1].weight, { value: 1, unit: "lb" });
  });

  it("uses a separate dimension system when given", () => {
    const p: Record<string, any> = {
      extensions: { unitSystem: "imperial", dimensionUnitSystem: "metric" },
      packages: [{ weight: { value: 2 }, dimensions: { length: 3 } }],
    };
    fillUnitsFromSystem(p);
    assert.equal(p.packages[0].weight.unit, "lb");
    assert.equal(p.packages[0].dimensions.unit, "cm");
  });

  it("does nothing without a unit system", () => {
    const p: Record<string, any> = { packages: [{ weight: { value: 2 } }] };
    assert.equal(fillUnitsFromSystem(p), 0);
    assert.equal(p.packages[0].weight.unit, undefined);
  });
});

describe("MyDHL request as a source", () => {
  before(async () => {
    await schemaRegistry.initialize();
    schemaRefResolver.loadFromRegistry(schemaRegistry);
    semanticMatcherService.setRefResolver(schemaRefResolver);
  });

  it("keeps the unit system and gives the packages kg and cm", async () => {
    const source = await loadJson("tests/fixtures/dhl-mydhl-shipment-request.json");
    const target = await loadJson("src/schemas/shipment/shipment-create-request.schema.json");
    const plan = await aiMappingService.generateMapping({
      sourceSchema: { type: "object", additionalProperties: true },
      targetSchema: target as Record<string, unknown>,
      sourceExamplePayload: source as Record<string, unknown>,
    });
    assert.ok(plan.mappings.some((m) => m.sourceField === "/content/unitOfMeasurement" && m.targetField === "/extensions"));
    const result = await new TransformationExecutorService().executeWithOptions({ sourcePayload: source, plan });
    const pkg = (result.targetPayload as Record<string, any>).packages[0];
    assert.deepEqual(pkg.weight, { value: 2.5, unit: "kg" });
    assert.equal(pkg.dimensions.unit, "cm");
  });
});
