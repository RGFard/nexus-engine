import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { loadJson } from "./helpers/load-schema.js";

// POST /outbound/transform through the real app: canonical in, DHL request out.

const DHL = { system: "dhl", schemaName: "shipment-create-request" };

let app: FastifyInstance;
let canonical: Record<string, any>;

async function transform(body: unknown) {
  return app.inject({ method: "POST", url: "/outbound/transform", payload: body as object });
}

before(async () => {
  app = await buildApp({ host: "127.0.0.1", port: 0, logLevel: "silent" });
  canonical = (await loadJson("tests/fixtures/canonical-shipment.json")) as Record<string, any>;
});

after(async () => {
  await app.close();
});

describe("GET /outbound/targets", () => {
  it("lists the DHL target with its plan", async () => {
    const res = await app.inject({ method: "GET", url: "/outbound/targets" });
    assert.equal(res.statusCode, 200);

    const dhl = res.json().targets.find((t: any) => t.system === "dhl");
    assert.equal(dhl.schemaName, "shipment-create-request");
    assert.equal(dhl.sourceSchemaId, "canonical://shipment/shipment-create-request");
    assert.ok(dhl.mappingCount > 0);
  });
});

describe("POST /outbound/transform", () => {
  it("turns a canonical shipment into a valid DHL request", async () => {
    const res = await transform({ canonicalPayload: canonical, target: DHL });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.deepEqual(body.validation, { valid: true });
    assert.equal(body.skippedMappings.length, 0);
    assert.equal(body.target.planId, "canonical-to-dhl/shipment-create-request");
    assert.equal(body.targetPayload.ShipmentInfo.ServiceType, "P");
    assert.equal(body.targetPayload.Recipient.Address.City, "New York");
    assert.deepEqual(body.targetPayload.Packages.RequestedPackages[0].Weight, { Unit: "KG", Value: 2.5 });
  });

  it("converts a unit DHL does not take, and says so", async () => {
    // EasyPost weighs in ounces. DHL takes kg and lb only.
    const payload = structuredClone(canonical);
    payload.packages[0].weight = { value: 24, unit: "oz" };
    payload.packages[0].dimensions = { length: 0.3, width: 0.2, height: 0.15, unit: "m" };

    const res = await transform({ canonicalPayload: payload, target: DHL });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.deepEqual(body.validation, { valid: true });
    assert.deepEqual(body.targetPayload.Packages.RequestedPackages[0].Weight, { Unit: "LB", Value: 1.5 });
    assert.deepEqual(body.targetPayload.Packages.RequestedPackages[0].Dimensions, {
      Height: 15,
      Length: 30,
      Unit: "CM",
      Width: 20,
    });
    // Reported in the order the blocks appear in the payload, so look each up by path.
    const byPath = Object.fromEntries(body.unitConversions.map((c: any) => [c.path, c]));
    assert.deepEqual(Object.keys(byPath).sort(), ["/packages/0/dimensions", "/packages/0/weight"]);
    assert.deepEqual(byPath["/packages/0/weight"].from, { value: 24, unit: "oz" });
    assert.deepEqual(byPath["/packages/0/weight"].to, { value: 1.5, unit: "lb" });
  });

  it("reports no conversions when every unit is one DHL takes", async () => {
    const res = await transform({ canonicalPayload: canonical, target: DHL });
    assert.deepEqual(res.json().unitConversions, []);
  });

  it("rejects a payload that is not valid canonical", async () => {
    // A likely wiring mistake: sending the source-format payload, not the canonical one.
    const dhlFormat = await loadJson("tests/fixtures/dhl-international-shipment.json");

    const res = await transform({ canonicalPayload: dhlFormat, target: DHL });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().error, /not a valid canonical/);
    assert.ok(res.json().details.length > 0);
  });

  it("returns 404 for a target with no saved plan", async () => {
    const res = await transform({ canonicalPayload: canonical, target: { system: "ups", schemaName: "shipment-create-request" } });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /Available: dhl\/shipment-create-request/);
  });

  it("returns 400 when the body is missing the target", async () => {
    const res = await transform({ canonicalPayload: canonical });
    assert.equal(res.statusCode, 400);
  });
});

describe("POST /outbound/transform parameters", () => {
  // What a non-DHL source looks like once it is canonical: no carrier block at all.
  function withoutCarrier(): Record<string, any> {
    const payload = structuredClone(canonical);
    delete payload.carrier;
    return payload;
  }

  it("lists the parameters a target accepts", async () => {
    const res = await app.inject({ method: "GET", url: "/outbound/targets" });
    const dhl = res.json().targets.find((t: any) => t.system === "dhl");
    assert.equal(dhl.parameters.serviceCode.targetField, "/ShipmentInfo/ServiceType");
    assert.deepEqual(dhl.units.weight, { accepted: ["kg", "lb"], convert: { oz: "lb", g: "kg" } });
  });

  it("is invalid for DHL when the source carried no service code and none is supplied", async () => {
    const res = await transform({ canonicalPayload: withoutCarrier(), target: DHL });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.validation.valid, false);
    assert.deepEqual(body.appliedParameters, []);
    assert.ok(body.validation.errors.some((e: any) => /ShipmentInfo/.test(e.message)));
  });

  it("is valid once the caller supplies the service code", async () => {
    const res = await transform({
      canonicalPayload: withoutCarrier(),
      target: DHL,
      parameters: { serviceCode: "P" },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.deepEqual(body.validation, { valid: true });
    assert.deepEqual(body.appliedParameters, ["serviceCode"]);
    assert.deepEqual(body.targetPayload.ShipmentInfo, { ServiceType: "P" });
  });

  it("a supplied service code replaces the one in the canonical payload", async () => {
    const payload = structuredClone(canonical);
    payload.carrier.serviceCode = "03"; // a UPS code, meaningless to DHL

    const res = await transform({ canonicalPayload: payload, target: DHL, parameters: { serviceCode: " U " } });

    const body = res.json();
    assert.equal(body.targetPayload.ShipmentInfo.ServiceType, "U");
    assert.equal(body.targetPayload.ShipmentInfo.Account, "123456789");
    assert.equal(body.validation.valid, true);
  });

  it("rejects a parameter the plan does not declare", async () => {
    const res = await transform({ canonicalPayload: canonical, target: DHL, parameters: { servicecode: "P" } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Unknown parameter "servicecode".*Accepted: serviceCode/);
  });

  it("rejects an empty parameter value", async () => {
    const res = await transform({ canonicalPayload: canonical, target: DHL, parameters: { serviceCode: "  " } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /non-empty/);
  });
});

describe("saved DHL plan integrity", () => {
  it("only names fields that exist in the canonical and DHL schemas", async () => {
    const plan = (await loadJson("src/target-plans/dhl/shipment-create-request.plan.json")) as Record<string, any>;
    const dhlSchema = await loadJson("src/target-schemas/dhl/shipment-create-request.schema.json");
    const canonicalSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;

    const canonicalPaths = new Set(semanticMatcherService.analyzeSchema(canonicalSchema).fields.map((f) => f.path));
    const dhlPaths = new Set(semanticMatcherService.analyzeSchema(dhlSchema).fields.map((f) => f.path));

    for (const m of plan.mappings) {
      assert.ok(canonicalPaths.has(m.sourceField), `not a canonical field: ${m.sourceField}`);
      assert.ok(dhlPaths.has(m.targetField), `not a DHL field: ${m.targetField}`);
    }
    for (const [name, param] of Object.entries<any>(plan.parameters ?? {})) {
      assert.ok(dhlPaths.has(param.targetField), `parameter ${name} targets a field DHL does not have: ${param.targetField}`);
    }
  });
});
