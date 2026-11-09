import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { aiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { applyTransformationSteps } from "../src/ai/services/transformation-engine.js";
import { loadJson } from "./helpers/load-schema.js";

// The real UPS Shipping API request (ShipmentRequest.Shipment), from UPS's own example.

let target: Record<string, unknown>;
before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
  target = (await loadJson("src/schemas/shipment/shipment-create-request.schema.json")) as Record<string, unknown>;
});

async function toCanonical(payload: Record<string, unknown>) {
  const plan = await aiMappingService.generateMapping({
    sourceSchema: { type: "object", additionalProperties: true },
    targetSchema: target,
    sourceExamplePayload: payload,
  });
  const r = await new TransformationExecutorService().executeWithOptions({ sourcePayload: payload, plan });
  return r.targetPayload as Record<string, any>;
}

describe("UPS ShipmentRequest as a source", () => {
  it("takes the origin from ShipFrom, not from the Shipper account owner", async () => {
    const c = await toCanonical((await loadJson("tests/fixtures/ups-ship-request.json")) as Record<string, unknown>);
    assert.equal(c.origin.city, "Alpharetta");
    assert.equal(c.origin.line1, "1000 Industrial Pkwy");
    assert.equal(c.origin.stateOrProvince, "GA");
    assert.equal(c.origin.company, "T and T Designs Warehouse");
    assert.equal(c.origin.name, "Dock Manager");
    assert.equal(c.origin.phone, "6785550100");
  });

  it("uses the Shipper address when there is no ShipFrom", async () => {
    const ups = (await loadJson("tests/fixtures/ups-ship-request.json")) as Record<string, any>;
    delete ups.ShipmentRequest.Shipment.ShipFrom;
    const c = await toCanonical(ups);
    assert.equal(c.origin.city, "Timonium");
    assert.equal(c.origin.line1, "2311 York Rd");
  });

  it("splits AddressLine into line1 and line2, and maps company and contact", async () => {
    const c = await toCanonical((await loadJson("tests/fixtures/ups-ship-request.json")) as Record<string, unknown>);
    assert.equal(c.destination.line1, "123 Main St");
    assert.equal(c.destination.line2, "Suite 4");
    assert.equal(c.destination.line3, undefined);
    assert.equal(c.destination.company, "Happy Dog Pet Supply");
    assert.equal(c.destination.name, "Jane Miller");
  });
});

describe("array:at", () => {
  const ctx = { sourcePayload: {}, mapping: { sourceField: "/a", targetField: "/b", confidence: 1, transformation: "", reasoning: "" } } as never;
  it("picks one item and skips missing or blank ones", () => {
    assert.equal(applyTransformationSteps(["a", "b"], "array:at:1", ctx), "b");
    assert.equal(applyTransformationSteps(["a"], "array:at:2", ctx), undefined);
    assert.equal(applyTransformationSteps(["a", " "], "array:at:1", ctx), undefined);
    assert.equal(applyTransformationSteps("solo", "array:at:0", ctx), "solo");
  });
});

describe("FedEx streetLines", () => {
  it("sends the second street line to line2", async () => {
    const c = await toCanonical((await loadJson("tests/fixtures/fedex-ship-request.json")) as Record<string, unknown>);
    assert.equal(c.destination.line1, "200 Oak Ave");
    assert.equal(c.destination.line2, "Apt 4");
  });
});
