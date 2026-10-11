import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyUnitPolicy,
  assertUnitPolicy,
  convertUnitValue,
  roundUp3,
  type UnitPolicy,
} from "../src/outbound/unit-conversion.js";

const DHL_UNITS: UnitPolicy = {
  weight: { accepted: ["kg", "lb"], convert: { oz: "lb", g: "kg" } },
  dimension: { accepted: ["cm", "in"], convert: { m: "cm" } },
};

describe("convertUnitValue", () => {
  it("converts inside one measuring system", () => {
    assert.equal(convertUnitValue("weight", 16, "oz", "lb"), 1);
    assert.equal(convertUnitValue("weight", 2500, "g", "kg"), 2.5);
    assert.equal(convertUnitValue("weight", 1100, "g", "kg"), 1.1);
    assert.equal(convertUnitValue("dimension", 0.305, "m", "cm"), 30.5);
  });

  it("keeps three decimals and never rounds down", () => {
    assert.equal(convertUnitValue("weight", 5, "oz", "lb"), 0.313); // 0.3125
    assert.equal(convertUnitValue("weight", 1, "g", "kg"), 0.001);
    assert.equal(convertUnitValue("weight", 0.4, "g", "kg"), 0.001); // 0.0004, not 0
    assert.equal(roundUp3(2.5), 2.5);
    assert.equal(roundUp3(0.1 + 0.2), 0.3); // floating-point noise is not rounded up
  });

  it("refuses to cross measuring systems", () => {
    assert.throws(() => convertUnitValue("weight", 1, "kg", "lb"), /Cannot convert/);
    assert.throws(() => convertUnitValue("dimension", 1, "cm", "in"), /Cannot convert/);
  });
});

describe("applyUnitPolicy", () => {
  const payload = {
    weight: { value: 32, unit: "oz" },
    packages: [
      { weight: { value: 16, unit: "oz" }, dimensions: { length: 0.3, width: 0.2, height: 0.15, unit: "m" } },
      { weight: { value: 2.5, unit: "kg" }, dimensions: { length: 30, width: 20, height: 15, unit: "cm" } },
    ],
    customs: { lineItems: [{ weight: { value: 250, unit: "g" } }] },
  };

  it("converts every weight and dimensions block the target does not accept", () => {
    const { payload: out } = applyUnitPolicy(payload, DHL_UNITS);

    assert.deepEqual(out.weight, { value: 2, unit: "lb" });
    assert.deepEqual(out.packages[0], {
      weight: { value: 1, unit: "lb" },
      dimensions: { length: 30, width: 20, height: 15, unit: "cm" },
    });
    assert.deepEqual(out.customs.lineItems[0].weight, { value: 0.25, unit: "kg" });
  });

  it("leaves accepted units exactly as they were", () => {
    const { payload: out } = applyUnitPolicy(payload, DHL_UNITS);
    assert.deepEqual(out.packages[1], payload.packages[1]);
  });

  it("reports each change with its path, and does not modify the input", () => {
    const { conversions } = applyUnitPolicy(payload, DHL_UNITS);

    assert.deepEqual(conversions.map((c) => c.path), [
      "/weight",
      "/packages/0/weight",
      "/packages/0/dimensions",
      "/customs/lineItems/0/weight",
    ]);
    assert.deepEqual(conversions[1], {
      path: "/packages/0/weight",
      kind: "weight",
      from: { value: 16, unit: "oz" },
      to: { value: 1, unit: "lb" },
    });
    assert.equal(payload.packages[0]!.weight.unit, "oz");
  });

  it("does nothing without a policy", () => {
    const result = applyUnitPolicy(payload, undefined);
    assert.equal(result.payload, payload);
    assert.deepEqual(result.conversions, []);
  });

  it("leaves a unit alone when the policy has no conversion for it", () => {
    const onlyKg: UnitPolicy = { weight: { accepted: ["kg"] } };
    const { payload: out, conversions } = applyUnitPolicy({ weight: { value: 16, unit: "oz" } }, onlyKg);
    assert.deepEqual(out.weight, { value: 16, unit: "oz" });
    assert.deepEqual(conversions, []);
  });

  it("leaves a block alone when a figure is not a number", () => {
    const { payload: out, conversions } = applyUnitPolicy({ weight: { value: "16", unit: "oz" } }, DHL_UNITS);
    assert.deepEqual(out.weight, { value: "16", unit: "oz" });
    assert.deepEqual(conversions, []);
  });
});

describe("assertUnitPolicy", () => {
  it("accepts the DHL policy and an absent one", () => {
    assertUnitPolicy(DHL_UNITS);
    assertUnitPolicy(undefined);
  });

  it("rejects a conversion across measuring systems", () => {
    assert.throws(
      () => assertUnitPolicy({ weight: { accepted: ["lb"], convert: { kg: "lb" } } }),
      /inside one measuring system/,
    );
  });

  it("rejects a conversion to a unit the target does not accept", () => {
    assert.throws(() => assertUnitPolicy({ weight: { accepted: ["kg"], convert: { oz: "lb" } } }), /does not accept/);
  });

  it("rejects unknown units and kinds", () => {
    assert.throws(() => assertUnitPolicy({ weight: { accepted: ["stone"] } }), /unknown unit/);
    assert.throws(() => assertUnitPolicy({ volume: { accepted: ["l"] } } as never), /Unknown unit kind/);
  });
});
