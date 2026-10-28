import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { applyTransformationSteps } from "../src/ai/services/transformation-engine.js";
import { loadJson } from "./helpers/load-schema.js";

// Canonical in, DHL Express MyDHL API 3.4.0 create-shipment request out, through the real app.

const DHL = { system: "dhl", schemaName: "shipment-create-request" };
let app: FastifyInstance;
let canonical: Record<string, any>;

async function toDhl(canonicalPayload: unknown, parameters?: Record<string, string>) {
  const res = await app.inject({
    method: "POST",
    url: "/outbound/transform",
    payload: { canonicalPayload, target: DHL, parameters } as object,
  });
  return res.json() as Record<string, any>;
}

function domestic(): Record<string, any> {
  const c = structuredClone(canonical);
  delete c.customs;
  c.origin = { ...c.origin, countryCode: "US", city: "Memphis", postalCode: "38118", stateOrProvince: "TN" };
  return c;
}

before(async () => {
  app = await buildApp({ host: "127.0.0.1", port: 0, logLevel: "silent" });
  canonical = (await loadJson("tests/fixtures/canonical-shipment.json")) as Record<string, any>;
  canonical.customs.incoterm = "DAP";
  canonical.customs.lineItems[0].weight = { value: 2.3, unit: "kg" };
});

after(async () => {
  await app.close();
});

const ctx = { sourcePayload: {}, mapping: { sourceField: "/a", targetField: "/b", confidence: 1, transformation: "", reasoning: "" } } as never;

describe("DHL date and list steps", () => {
  it("date:dhlShipTime gives now in DHL's GMT format, and keeps a future date", () => {
    const now = applyTransformationSteps(undefined, "constant:now|date:dhlShipTime", ctx) as string;
    assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} GMT\+00:00$/);
    assert.equal(applyTransformationSteps("2020-01-01T10:00:00Z", "date:dhlShipTime", ctx) === "2020-01-01T10:00:00 GMT+00:00", false);
    assert.equal(applyTransformationSteps("2099-05-01T10:00:00Z", "date:dhlShipTime", ctx), "2099-05-01T10:00:00 GMT+00:00");
  });

  it("array:positions numbers list items from 1", () => {
    assert.deepEqual(applyTransformationSteps(["a", "b", "c"], "array:positions", ctx), [1, 2, 3]);
  });
});

describe("canonical to DHL", () => {
  it("turns the international canonical sample into a valid DHL request", async () => {
    const body = await toDhl(canonical);
    assert.deepEqual(body.validation, { valid: true });
    const dhl = body.targetPayload;
    assert.equal(dhl.productCode, "P");
    assert.deepEqual(dhl.accounts, [{ number: "123456789", typeCode: "shipper" }]);
    assert.deepEqual(dhl.pickup, { isRequested: false });
    assert.match(dhl.plannedShippingDateAndTime, / GMT\+00:00$/);
    assert.equal(dhl.customerDetails.shipperDetails.contactInformation.companyName, "Export GmbH");
    assert.equal(dhl.customerDetails.shipperDetails.contactInformation.fullName, "Anna Schmidt");
    assert.equal(dhl.content.isCustomsDeclarable, true);
    assert.equal(dhl.content.unitOfMeasurement, "metric");
    const [declaration] = dhl.content.exportDeclarations;
    assert.equal(declaration.incoterm, "DAP");
    assert.equal(declaration.exportReasonType, "commercial_purpose_or_sale");
    assert.equal(declaration.invoice.number, "REF-001");
    assert.deepEqual(declaration.lineItems[0].quantity, { value: 10, unitOfMeasurement: "PCS" });
    assert.deepEqual(declaration.lineItems[0].commodityCodes, [{ typeCode: "outbound", value: "610910" }]);
    assert.deepEqual(declaration.lineItems[0].weight, { netValue: 2.3, grossValue: 2.3 });
    assert.equal(declaration.lineItems[0].number, 1);
  });

  it("sends a domestic shipment with no customs block and an imperial unit system", async () => {
    const c = domestic();
    c.packages = [
      { weight: { value: 5, unit: "lb" }, dimensions: { length: 12, width: 10, height: 8, unit: "in" }, description: "Cotton T-shirts" },
      { weight: { value: 32, unit: "oz" } },
    ];
    const body = await toDhl(c, { serviceCode: "N" });
    assert.deepEqual(body.validation, { valid: true });
    const content = body.targetPayload.content;
    assert.equal(content.isCustomsDeclarable, false);
    assert.equal(content.exportDeclarations, undefined);
    assert.equal(content.unitOfMeasurement, "imperial");
    assert.deepEqual(content.packages.map((p: any) => p.weight), [5, 2]);
    assert.equal(content.description, "Cotton T-shirts");
  });

  it("uses the contact name as company name when there is no company, and the reverse", async () => {
    const c = domestic();
    delete c.destination.company;
    delete c.origin.name;
    const body = await toDhl(c);
    assert.deepEqual(body.validation, { valid: true });
    const d = body.targetPayload.customerDetails;
    assert.equal(d.receiverDetails.contactInformation.companyName, "John Doe");
    assert.equal(d.shipperDetails.contactInformation.fullName, "Export GmbH");
  });

  it("falls back to General goods when nothing describes the shipment", async () => {
    const c = domestic();
    delete c.packages[0].description;
    const body = await toDhl(c);
    assert.deepEqual(body.validation, { valid: true });
    assert.equal(body.targetPayload.content.description, "General goods");
  });

  it("prefers the customs contents description, then the first customs line", async () => {
    const c = structuredClone(canonical);
    c.packages[0].description = "Box 1";
    let body = await toDhl(c);
    assert.equal(body.targetPayload.content.description, "Cotton T-shirts", "first customs line beats the package");
    c.customs.contentsDescription = "Clothing";
    body = await toDhl(c);
    assert.equal(body.targetPayload.content.description, "Clothing");
  });

  it("names what is missing in canonical terms", async () => {
    const c = structuredClone(canonical);
    delete c.carrier;
    delete c.origin.phone;
    delete c.customs.incoterm;
    delete c.customs.declaredValue;
    const body = await toDhl(c);
    assert.equal(body.validation.valid, false);
    const fields = body.validation.errors.map((e: any) => e.canonicalField ?? e.header);
    for (const f of ["/carrier/serviceCode", "/carrier/accountNumber", "/origin/phone", "/customs/incoterm"]) {
      assert.ok(fields.includes(f), `expected an error for ${f}: ${JSON.stringify(fields)}`);
    }
    assert.ok(!body.validation.errors.some((e: any) => /"then"/.test(e.message)), "no raw if/then error");
    const account = body.validation.errors.find((e: any) => e.canonicalField === "/carrier/accountNumber");
    assert.equal(account.header, "X-Account-Number");
  });

  it("the account header fills the DHL account when the source has none", async () => {
    const c = domestic();
    delete c.carrier;
    const body = await toDhl(c, { serviceCode: "N", accountNumber: "987654321" });
    assert.deepEqual(body.validation, { valid: true });
    assert.deepEqual(body.targetPayload.accounts, [{ typeCode: "shipper", number: "987654321" }]);
  });
});
