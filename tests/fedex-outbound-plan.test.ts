import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { loadJson } from "./helpers/load-schema.js";

// Canonical in, FedEx Ship API create-shipment request out, through the real app.

const FEDEX = { system: "fedex", schemaName: "shipment-create-request" };
let app: FastifyInstance;
let canonical: Record<string, any>;

async function toFedex(canonicalPayload: unknown, parameters?: Record<string, string>) {
  const res = await app.inject({
    method: "POST",
    url: "/outbound/transform",
    payload: { canonicalPayload, target: FEDEX, parameters } as object,
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

before(async () => {
  app = await buildApp({ host: "127.0.0.1", port: 0, logLevel: "silent" });
  canonical = (await loadJson("tests/fixtures/canonical-shipment.json")) as Record<string, any>;
});

after(async () => {
  await app.close();
});

describe("canonical to FedEx", () => {
  it("turns the international canonical sample into a valid FedEx request", async () => {
    const { status, body } = await toFedex(canonical, { serviceCode: "INTERNATIONAL_PRIORITY" });
    assert.equal(status, 200);
    assert.deepEqual(body.validation, { valid: true });
    const rs = body.targetPayload.requestedShipment;
    assert.equal(body.targetPayload.accountNumber.value, "123456789");
    assert.equal(body.targetPayload.labelResponseOptions, "URL_ONLY");
    assert.equal(rs.serviceType, "INTERNATIONAL_PRIORITY");
    assert.deepEqual(rs.shipper.address.streetLines, ["Hauptstrasse 5"]);
    assert.equal(rs.recipients.length, 1);
    assert.equal(rs.recipients[0].contact.phoneNumber, "+1 212 555 0100");
    assert.equal(rs.totalWeight, 2.5);
    assert.deepEqual(rs.requestedPackageLineItems[0].weight, { units: "KG", value: 2.5 });
    assert.equal(rs.customsClearanceDetail.commercialInvoice.shipmentPurpose, "SOLD");
    assert.equal(rs.customsClearanceDetail.commodities[0].quantityUnits, "PCS");
    assert.equal(rs.pickupType, "USE_SCHEDULED_PICKUP");
  });

  it("handles several packages, address lines, converted units and rounding", async () => {
    const c = structuredClone(canonical);
    delete c.customs;
    c.origin = { ...c.origin, countryCode: "US", city: "Memphis", stateOrProvince: "TN", postalCode: "38118", line2: "Dock 3" };
    c.destination = { ...c.destination, line2: "Apt 4", line3: "Rear entrance", stateOrProvince: "NY", residential: true };
    c.packages = [
      { weight: { value: 80, unit: "oz" }, dimensions: { length: 12.2, width: 10, height: 7.5, unit: "in" } },
      { weight: { value: 2, unit: "lb" }, dimensions: { length: 0.305, width: 0.2, height: 0.1, unit: "m" } },
    ];
    const { body } = await toFedex(c, { serviceCode: "FEDEX_GROUND", accountNumber: "740561073" });
    assert.deepEqual(body.validation, { valid: true });
    const rs = body.targetPayload.requestedShipment;
    assert.equal(body.targetPayload.accountNumber.value, "740561073", "parameter replaces the canonical account");
    assert.deepEqual(rs.shipper.address.streetLines, ["Hauptstrasse 5", "Dock 3"]);
    assert.deepEqual(rs.recipients[0].address.streetLines, ["456 Customer Ave", "Apt 4", "Rear entrance"]);
    assert.equal(rs.recipients[0].address.residential, true);
    assert.equal(rs.recipients[0].address.stateOrProvinceCode, "NY");
    const [p1, p2] = rs.requestedPackageLineItems;
    assert.deepEqual(p1.weight, { units: "LB", value: 5 });
    assert.deepEqual(p1.dimensions, { length: 13, width: 10, height: 8, units: "IN" });
    assert.deepEqual(p2.dimensions, { length: 31, width: 20, height: 10, units: "CM" });
    assert.equal(rs.totalWeight, 7);
    assert.equal(p1.customerReferences[0].value, "REF-001");
    assert.equal(p2.customerReferences[0].customerReferenceType, "CUSTOMER_REFERENCE");
    assert.equal(rs.customsClearanceDetail, undefined, "no customs block for a domestic shipment");
  });

  it("drops customs data that has no line items", async () => {
    const c = structuredClone(canonical);
    c.destination.countryCode = "DE";
    delete c.customs.lineItems;
    const { body } = await toFedex(c, { serviceCode: "FEDEX_GROUND" });
    assert.deepEqual(body.validation, { valid: true });
    assert.equal(body.targetPayload.requestedShipment.customsClearanceDetail, undefined);
    assert.deepEqual(body.droppedBlocks, ["/requestedShipment/customsClearanceDetail"]);
  });

  it("tells the caller which canonical field or header fixes each FedEx error", async () => {
    const c = structuredClone(canonical);
    delete c.origin.phone;
    delete c.destination.phone;
    delete c.carrier;
    const { body } = await toFedex(c);
    assert.equal(body.validation.valid, false);
    const byField = Object.fromEntries(body.validation.errors.map((e: any) => [e.canonicalField ?? e.header, e]));
    assert.equal(byField["/origin/phone"].message, "FedEx requires the shipper phone (/origin/phone). To fix: add it to the request.");
    assert.equal(byField["/destination/phone"].message, "FedEx requires the recipient phone (/destination/phone). To fix: add it to the request.");
    assert.equal(
      byField["/carrier/accountNumber"].message,
      "FedEx requires the carrier account number (/carrier/accountNumber). To fix: add it to the request, or send the X-Account-Number header.",
    );
    assert.equal(byField["/carrier/accountNumber"].header, "X-Account-Number");
    assert.equal(byField["/carrier/serviceCode"].header, "X-Service-Code");
  });

  it("fails FedEx validation when there is no phone number", async () => {
    const c = structuredClone(canonical);
    delete c.destination.phone;
    const { body } = await toFedex(c, { serviceCode: "INTERNATIONAL_PRIORITY" });
    assert.equal(body.validation.valid, false);
    assert.ok(body.validation.errors.some((e: any) => e.canonicalField === "/destination/phone"));
  });

  it("fails FedEx validation when no service is known", async () => {
    const c = structuredClone(canonical);
    delete c.carrier.serviceCode;
    const { body } = await toFedex(c);
    assert.equal(body.validation.valid, false);
    assert.ok(body.validation.errors.some((e: any) => e.canonicalField === "/carrier/serviceCode"));
  });
});

// Every path in a JSON schema, following its local #/definitions refs (the FedEx schema
// shares one "party" definition between shipper and recipients).
function schemaPaths(root: Record<string, any>): Set<string> {
  const paths = new Set<string>();
  const resolve = (n: any): any => (n?.$ref ? resolve(n.$ref.slice(2).split("/").reduce((o: any, k: string) => o[k], root)) : n);
  const walk = (node: any, path: string) => {
    const n = resolve(node);
    if (path) paths.add(path);
    if (n?.items) walk(n.items, `${path}[]`);
    for (const [k, v] of Object.entries<any>(n?.properties ?? {})) walk(v, `${path}/${k}`);
  };
  walk(root, "");
  return paths;
}

describe("saved FedEx plan integrity", () => {
  it("only names fields that exist in the canonical and FedEx schemas", async () => {
    const plan = (await loadJson("src/target-plans/fedex/shipment-create-request.plan.json")) as Record<string, any>;
    const fedexSchema = await loadJson("src/target-schemas/fedex/shipment-create-request.schema.json");
    const canonicalSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;
    const canonicalPaths = new Set(semanticMatcherService.analyzeSchema(canonicalSchema).fields.map((f) => f.path));
    const fedexPaths = schemaPaths(fedexSchema as Record<string, any>);
    // A list position like streetLines[0] names the same field as streetLines[].
    const asField = (p: string) => p.replace(/\[\d+\]/g, "[]");
    const isFedexField = (p: string) => fedexPaths.has(asField(p)) || fedexPaths.has(asField(p).replace(/\[\]$/, ""));

    for (const m of plan.mappings) {
      assert.ok(canonicalPaths.has(m.sourceField), `not a canonical field: ${m.sourceField}`);
      assert.ok(isFedexField(m.targetField), `not a FedEx field: ${m.targetField}`);
    }
    for (const path of Object.keys(plan.defaults ?? {})) {
      assert.ok(isFedexField(path), `default targets a field FedEx does not have: ${path}`);
    }
    for (const [name, param] of Object.entries<any>(plan.parameters ?? {})) {
      assert.ok(isFedexField(param.targetField), `parameter ${name} targets a field FedEx does not have: ${param.targetField}`);
    }
  });
});
