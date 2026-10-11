import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { getByPath, resolveMappingSourceValue } from "../src/ai/utils/json-path.js";
import type { FieldMapping } from "../src/ai/models/mapping.types.js";

// Regression: a `key[]/child` read used to return undefined and fall back to item 0,
// so a shipment with two packages came out with one and still validated.

const SOURCE = {
  Reference: "REF-9",
  Packages: [
    { Weight: { Value: "2.5", Unit: "KG" }, Dims: { Length: 30 } },
    { Weight: { Value: 7, Unit: "LB" } },
  ],
};

function map(sourceField: string, targetField: string, transformation: string): FieldMapping {
  return { sourceField, targetField, confidence: 1, transformation, reasoning: "test" };
}

async function run(mappings: FieldMapping[], sourcePayload: unknown = SOURCE) {
  const executor = new TransformationExecutorService();
  return executor.executeWithOptions({
    sourcePayload,
    plan: { mappings, unmappedSourceFields: [], unmappedTargetFields: [] },
  });
}

describe("wildcard reads return every array item", () => {
  it("getByPath reads a child of every item", () => {
    assert.deepEqual(getByPath(SOURCE, "/Packages[]/Weight/Value"), ["2.5", 7]);
    assert.deepEqual(getByPath(SOURCE, "/Packages[]/Dims/Length"), [30, undefined]);
  });

  it("a scalar target still gets the first item only", () => {
    assert.equal(resolveMappingSourceValue(SOURCE, "/Packages[]/Weight/Unit", "/weightUnit"), "KG");
  });

  it("an array target gets every item", () => {
    assert.deepEqual(
      resolveMappingSourceValue(SOURCE, "/Packages[]/Weight/Unit", "/packages[]/weight/unit"),
      ["KG", "LB"],
    );
  });
});

describe("executor keeps every package", () => {
  it("maps two packages to two packages, transforming each item on its own", async () => {
    const result = await run([
      map("/Packages[]/Weight/Value", "/packages[]/weight/value", "array:map|cast:number"),
      map("/Packages[]/Weight/Unit", "/packages[]/weight/unit", "cast:string|normalize:weightUnit"),
    ]);

    assert.equal(result.skippedMappings.length, 0);
    assert.deepEqual((result.targetPayload as { packages: unknown }).packages, [
      { weight: { value: 2.5, unit: "kg" } },
      { weight: { value: 7, unit: "lb" } },
    ]);
  });

  it("leaves an item alone when it has no value for the field", async () => {
    const result = await run([
      map("/Packages[]/Weight/Value", "/packages[]/weight/value", "array:map|cast:number"),
      map("/Packages[]/Dims/Length", "/packages[]/dimensions/length", "array:map|cast:number"),
    ]);

    assert.deepEqual((result.targetPayload as { packages: unknown }).packages, [
      { weight: { value: 2.5 }, dimensions: { length: 30 } },
      { weight: { value: 7 } },
    ]);
  });

  it("skips the mapping when no item has the field", async () => {
    const result = await run([
      map("/Packages[]/Missing", "/packages[]/description", "array:map"),
    ]);

    assert.equal(result.appliedMappings.length, 0);
    assert.deepEqual(result.targetPayload, {});
  });

  it("still broadcasts a shipment-level scalar to every item", async () => {
    const result = await run([
      map("/Packages[]/Weight/Value", "/packages[]/weight/value", "array:map|cast:number"),
      map("/Reference", "/packages[]/packageId", "direct|cast:string"),
    ]);

    assert.deepEqual((result.targetPayload as { packages: unknown }).packages, [
      { weight: { value: 2.5 }, packageId: "REF-9" },
      { weight: { value: 7 }, packageId: "REF-9" },
    ]);
  });

  it("array:first onto a scalar target takes the first item", async () => {
    const result = await run([
      map("/Packages[]/Weight/Unit", "/firstUnit", "array:first|cast:string"),
    ]);

    assert.deepEqual(result.targetPayload, { firstUnit: "KG" });
  });
});
