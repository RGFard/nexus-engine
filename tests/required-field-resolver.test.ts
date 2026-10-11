import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requiredFieldResolverService } from "../src/ai/services/required-field-resolver.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";

// A required string target whose name ("ServiceType") shares a concept with the source
// object's name ("carrier"). Before the fix the resolver mapped the whole /carrier object
// onto it and the executor wrote the text "[object Object]".
const TARGET_SCHEMA = {
  type: "object",
  required: ["ShipmentInfo"],
  properties: {
    ShipmentInfo: {
      type: "object",
      required: ["ServiceType"],
      properties: { ServiceType: { type: "string" } },
    },
  },
};

function resolveFor(payload: Record<string, unknown>) {
  const source = semanticMatcherService.analyzeSchema(
    semanticMatcherService.inferSchemaFromPayload(payload, "Source"),
    payload,
  );
  const target = semanticMatcherService.analyzeSchema(TARGET_SCHEMA);
  return requiredFieldResolverService.resolve(source, target, []);
}

describe("required-field resolver: container sources", () => {
  it("never maps an object onto a primitive required target", () => {
    const { augmentedMappings, suggestions } = resolveFor({
      carrier: { accountNumber: "123456789", serviceCode: "P" },
    });

    assert.ok(
      !augmentedMappings.some((m) => m.sourceField === "/carrier"),
      "the /carrier object must not be used as a mapping source",
    );
    for (const s of suggestions) {
      assert.ok(!s.suggestedSourceFields.includes("/carrier"), "objects must not be suggested either");
    }
  });

  it("never maps an array of objects onto a primitive required target", () => {
    const { augmentedMappings, suggestions } = resolveFor({
      carrier: [{ serviceCode: "P" }],
    });

    assert.ok(!augmentedMappings.some((m) => m.sourceField === "/carrier"));
    for (const s of suggestions) {
      assert.ok(!s.suggestedSourceFields.includes("/carrier"));
    }
  });

  it("still maps a scalar source onto the required target", () => {
    const { augmentedMappings } = resolveFor({ serviceType: "P" });
    const hit = augmentedMappings.find((m) => m.targetField === "/ShipmentInfo/ServiceType");
    assert.equal(hit?.sourceField, "/serviceType");
  });
});
