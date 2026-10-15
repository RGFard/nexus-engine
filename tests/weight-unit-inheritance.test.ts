import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inheritTotalWeightUnit } from "../src/ai/utils/weight-unit-inheritance.js";

const pkg = (unit: string) => ({ weight: { value: 1, unit } });

describe("inheritTotalWeightUnit", () => {
  it("fills the total weight unit from the packages", () => {
    const p: Record<string, unknown> = { weight: { value: 5.2 }, packages: [pkg("lb"), pkg("lb")] };
    assert.equal(inheritTotalWeightUnit(p), "lb");
    assert.deepEqual(p.weight, { value: 5.2, unit: "lb" });
  });

  it("leaves an existing unit alone", () => {
    const p: Record<string, unknown> = { weight: { value: 2, unit: "kg" }, packages: [pkg("lb")] };
    assert.equal(inheritTotalWeightUnit(p), undefined);
    assert.deepEqual(p.weight, { value: 2, unit: "kg" });
  });

  it("does nothing when packages disagree or have no unit", () => {
    const mixed: Record<string, unknown> = { weight: { value: 3 }, packages: [pkg("lb"), pkg("kg")] };
    assert.equal(inheritTotalWeightUnit(mixed), undefined);
    const none: Record<string, unknown> = { weight: { value: 3 }, packages: [{}] };
    assert.equal(inheritTotalWeightUnit(none), undefined);
  });

  it("does nothing when there is no total weight", () => {
    const p: Record<string, unknown> = { packages: [pkg("lb")] };
    assert.equal(inheritTotalWeightUnit(p), undefined);
    assert.equal(p.weight, undefined);
  });
});
