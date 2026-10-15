import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTransformationSteps } from "../src/ai/services/transformation-engine.js";

const ctx = (sourcePayload: unknown = {}) =>
  ({
    sourcePayload,
    mapping: { sourceField: "/a/streetLines", targetField: "/destination/line1", confidence: 1, transformation: "", reasoning: "" },
  }) as never;

describe("concat:{N}", () => {
  it("indexes into an array value", () => {
    assert.equal(applyTransformationSteps(["200 Oak Ave", "Apt 4"], "concat:{1}|cast:string", ctx()), "Apt 4");
  });

  it("treats a scalar as item 0 after array:first already unwrapped it", () => {
    assert.equal(
      applyTransformationSteps(["200 Oak Ave", "Apt 4"], "array:first|concat:{0}|cast:string", ctx()),
      "200 Oak Ave",
    );
  });

  it("gives an empty string for a higher index on a scalar", () => {
    assert.equal(applyTransformationSteps("200 Oak Ave", "concat:{1}", ctx()), "");
  });
});
