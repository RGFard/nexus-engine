import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { setByPath } from "../src/ai/utils/json-path.js";
import { applyTransformationSteps } from "../src/ai/services/transformation-engine.js";
import { OutboundService } from "../src/outbound/outbound.service.js";
import type { OutboundTargetRegistry } from "../src/outbound/outbound-target.registry.js";
import type { SavedOutboundPlan } from "../src/outbound/outbound.types.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { loadJson } from "./helpers/load-schema.js";
import { setLogger } from "../src/utils/logger.js";
import pino from "pino";

const ctx = { sourcePayload: {}, mapping: { sourceField: "/x", targetField: "/y", confidence: 1, transformation: "", reasoning: "" } } as never;

describe("setByPath with an index", () => {
  it("writes array items by position", () => {
    const t: Record<string, any> = {};
    setByPath(t, "/address/streetLines[0]", "200 Oak Ave");
    setByPath(t, "/address/streetLines[1]", "Apt 4");
    assert.deepEqual(t, { address: { streetLines: ["200 Oak Ave", "Apt 4"] } });
  });

  it("walks into an indexed object", () => {
    const t: Record<string, any> = {};
    setByPath(t, "/recipients[0]/contact/phoneNumber", "555");
    setByPath(t, "/recipients[0]/address/city", "LA");
    assert.deepEqual(t, { recipients: [{ contact: { phoneNumber: "555" }, address: { city: "LA" } }] });
  });
});

describe("math:ceil and array:sum", () => {
  it("rounds up, item by item for arrays", () => {
    assert.equal(applyTransformationSteps(12.1, "math:ceil", ctx), 13);
    assert.equal(applyTransformationSteps(12, "math:ceil", ctx), 12);
    assert.deepEqual(applyTransformationSteps([12.4, 10, 7.001], "array:map|cast:number|math:ceil", ctx), [13, 10, 8]);
  });

  it("sums numbers without float noise", () => {
    assert.equal(applyTransformationSteps([5.2, 1.1], "array:sum", ctx), 6.3);
    assert.equal(applyTransformationSteps([0.1, 0.2], "array:sum", ctx), 0.3);
  });

  it("leaves non-numeric input alone", () => {
    assert.deepEqual(applyTransformationSteps(["a", 1], "array:sum", ctx), ["a", 1]);
    assert.equal(applyTransformationSteps(4, "array:sum", ctx), 4);
  });
});

describe("replace: and lookup:", () => {
  it("replace writes a fixed value only where a value exists", () => {
    assert.equal(applyTransformationSteps(10, "replace:PCS", ctx), "PCS");
    assert.equal(applyTransformationSteps(undefined, "replace:PCS", ctx), undefined);
    assert.deepEqual(applyTransformationSteps([1, null, 3], "replace:PCS", ctx), ["PCS", null, "PCS"]);
  });

  it("lookup swaps known codes and drops unknown ones", () => {
    const step = "lookup:merchandise=SOLD,gift=GIFT";
    assert.equal(applyTransformationSteps("merchandise", step, ctx), "SOLD");
    assert.equal(applyTransformationSteps("gift", step, ctx), "GIFT");
    assert.equal(applyTransformationSteps("other", step, ctx), undefined);
  });
});

describe("outbound plan defaults", () => {
  let service: OutboundService;
  let canonical: Record<string, any>;
  const plan: SavedOutboundPlan = {
    planId: "test/defaults",
    planVersion: "1.0.0",
    sourceSchemaId: "canonical://shipment/shipment-create-request",
    targetSchemaId: "target://test/x",
    mappings: [{ sourceField: "/origin/city", targetField: "/city", confidence: 1, transformation: "direct", reasoning: "" }],
    unmappedSourceFields: [],
    unmappedTargetFields: [],
    defaults: { "/city": "DEFAULT", "/pickupType": "USE_SCHEDULED_PICKUP", "/label/imageType": "PDF" },
    parameters: { pickup: { targetField: "/pickupType" } },
  } as SavedOutboundPlan;

  before(async () => {
    setLogger(pino({ level: "silent" }) as never);
    await schemaRegistry.initialize();
    const validate = Object.assign(() => true, { errors: null });
    const targets = { get: () => ({ plan, validate }), list: () => [] } as unknown as OutboundTargetRegistry;
    const validation = new SchemaValidationService(schemaRegistry);
    await validation.initialize();
    service = new OutboundService(targets, schemaRegistry, validation);
    canonical = (await loadJson("tests/fixtures/canonical-shipment.json")) as Record<string, any>;
  });

  it("fills empty paths only, and a parameter still wins", async () => {
    const r = await service.transform({
      canonicalPayload: canonical,
      target: { system: "test", schemaName: "x" },
      parameters: { pickup: "DROPOFF_AT_FEDEX_LOCATION" },
    });
    const out = r.targetPayload as Record<string, any>;
    assert.equal(out.city, canonical.origin.city, "mapped value is kept");
    assert.equal(out.label.imageType, "PDF");
    assert.equal(out.pickupType, "DROPOFF_AT_FEDEX_LOCATION");
    assert.deepEqual(r.appliedDefaults, ["/pickupType", "/label/imageType"]);
  });
});
