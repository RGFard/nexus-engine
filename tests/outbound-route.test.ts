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

  it("reports invalid, with the failing path, when the result breaks the DHL schema", async () => {
    const payload = structuredClone(canonical);
    payload.packages[0].weight.unit = "oz";

    const res = await transform({ canonicalPayload: payload, target: DHL });
    assert.equal(res.statusCode, 200);

    const { validation } = res.json();
    assert.equal(validation.valid, false);
    assert.ok(
      validation.errors.some((e: any) => e.instancePath === "/Packages/RequestedPackages/0/Weight/Unit"),
      JSON.stringify(validation.errors),
    );
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
  });
});
