import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { applyTransformationSteps } from "../src/ai/services/transformation-engine.js";
import { loadJson } from "./helpers/load-schema.js";

// The saved canonical -> DHL plan, run through the real executor and checked against
// the DHL target schema. tests/fixtures/canonical-shipment.json is what the engine
// produces from tests/fixtures/dhl-international-shipment.json.

const PLAN = "src/target-plans/dhl/shipment-create-request.plan.json";
const SCHEMA = "src/target-schemas/dhl/shipment-create-request.schema.json";

let validate: ValidateFunction;
const executor = new TransformationExecutorService();

async function toDhl(canonical: Record<string, unknown>) {
  const plan = await loadJson(PLAN);
  const result = await executor.executeWithOptions({ sourcePayload: canonical, plan: plan as never });
  return { result, dhl: result.targetPayload as Record<string, any> };
}

before(async () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  (addFormatsModule as unknown as (instance: Ajv) => void)(ajv);
  validate = ajv.compile(await loadJson(SCHEMA));
});

describe("normalize:uppercase", () => {
  const ctx = { sourcePayload: {}, mapping: { sourceField: "/a", targetField: "/b", confidence: 1, transformation: "", reasoning: "" } };

  it("uppercases and trims strings, leaves other values alone", () => {
    assert.equal(applyTransformationSteps(" kg ", "normalize:uppercase", ctx), "KG");
    assert.equal(applyTransformationSteps(5, "normalize:uppercase", ctx), 5);
    assert.equal(applyTransformationSteps(null, "normalize:uppercase", ctx), null);
  });
});

describe("canonical -> DHL saved plan", () => {
  it("applies every mapping and produces a DHL request that passes the DHL schema", async () => {
    const { result, dhl } = await toDhl(await loadJson("tests/fixtures/canonical-shipment.json"));

    assert.deepEqual(result.skippedMappings, []);
    assert.equal(validate(dhl), true, JSON.stringify(validate.errors));
  });

  it("round-trips the DHL sample", async () => {
    const original = (await loadJson("tests/fixtures/dhl-international-shipment.json")) as Record<string, any>;
    const { dhl } = await toDhl(await loadJson("tests/fixtures/canonical-shipment.json"));

    // Known differences: Content is not mapped yet, and the date gains milliseconds.
    const expected = structuredClone(original);
    delete expected.InternationalDetail.Content;
    expected.ShipmentCreationDate = "2026-10-07T10:00:00.000Z";

    assert.deepEqual(dhl, expected);
  });

  it("sends every package, with units in capitals", async () => {
    const canonical = (await loadJson("tests/fixtures/canonical-shipment.json")) as Record<string, any>;
    canonical.packages.push({ weight: { value: 7, unit: "lb" }, dimensions: { length: 9, width: 8, height: 7, unit: "in" } });

    const { dhl } = await toDhl(canonical);
    const packages = dhl.Packages.RequestedPackages;

    assert.equal(packages.length, 2);
    assert.deepEqual(packages.map((p: any) => [p.Weight.Unit, p.Dimensions.Unit]), [["KG", "CM"], ["LB", "IN"]]);
    assert.equal(validate(dhl), true, JSON.stringify(validate.errors));
  });

  // Conversion (oz to lb and so on) is the outbound service's job and runs before the
  // plan's mappings; see tests/unit-conversion.test.ts and tests/outbound-route.test.ts.
  it("the mappings alone do not convert units: an unconverted oz fails the DHL schema", async () => {
    const canonical = (await loadJson("tests/fixtures/canonical-shipment.json")) as Record<string, any>;
    canonical.packages[0].weight.unit = "oz";

    const { dhl } = await toDhl(canonical);

    assert.equal(dhl.Packages.RequestedPackages[0].Weight.Unit, "OZ");
    assert.equal(validate(dhl), false);
  });
});
