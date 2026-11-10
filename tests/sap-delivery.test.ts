import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { AiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { InMemoryLearnedVocabularyStore } from "../src/ai/services/learned-vocabulary.store.js";
import { InMemoryVocabularyStore } from "../src/ai/services/custom-vocabulary.store.js";
import { loadAiConfig } from "../src/ai/config.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { LocationRegistry } from "../src/ai/services/location-registry.service.js";
import { getByPath } from "../src/ai/utils/json-path.js";
import { toCanonicalDateTimeString } from "../src/ai/utils/date-normalize.js";
import { loadJson } from "./helpers/load-schema.js";

// SAP S/4HANA Outbound Delivery (API_OUTBOUND_DELIVERY_SRV), read with partners, items
// and handling units. The AI is stubbed with what the live model proposed: the partner
// fields read from "the first partner", which is the sold-to in this sample, not the ship-to.

const P = "/d/to_DeliveryDocumentPartner/results[]/to_Address";
const AI = [
  ["CityName", "city"], ["Country", "countryCode"], ["EmailAddress", "email"], ["PhoneNumber", "phone"],
  ["Region", "stateOrProvince"], ["PostalCode", "postalCode"], ["BusinessPartnerName1", "name"],
  ["BusinessPartnerName2", "line2"],
].map(([f, t]) => ({ sourceField: `${P}/${f}`, targetField: `/destination/${t}`, confidence: 0.9, transformation: "array:first|cast:string", reasoning: "stub" }))
  .concat([{ sourceField: `${P}/StreetName`, targetField: "/destination/line1", confidence: 0.9, transformation: `concat:${P}/StreetName,${P}/HouseNumber|array:first|cast:string`, reasoning: "stub" }])
  .concat(
    [
      ["/d/to_HandlingUnitHeaderDelivery/results[]/GrossWeight", "/packages[]/weight/value", "array:map|cast:number"],
      ["/d/to_HandlingUnitHeaderDelivery/results[]/WeightUnit", "/packages[]/weight/unit", "array:map|normalize:lowercase|cast:string"],
      ["/d/HeaderGrossWeight", "/weight/value", "cast:number"],
      ["/d/HeaderWeightUnit", "/weight/unit", "direct|normalize:lowercase|cast:string"],
    ].map(([sourceField, targetField, transformation]) => ({ sourceField, targetField, confidence: 0.9, transformation, reasoning: "stub" })),
  );

let target: Record<string, unknown>;
let validation: SchemaValidationService;
before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
  target = (await loadJson("src/schemas/shipment/shipment-create-request.schema.json")) as Record<string, unknown>;
  validation = new SchemaValidationService(schemaRegistry);
  await validation.initialize();
});

async function toCanonical(payload: Record<string, unknown>) {
  const config = { ...loadAiConfig(), anthropicApiKey: undefined, mappingEnabled: true, aiFallbackEnabled: true };
  const svc = new AiMappingService(config, new InMemoryVocabularyStore(), new InMemoryLearnedVocabularyStore());
  (svc as unknown as { anthropic: unknown }).anthropic = {
    messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify({ mappings: AI }) }] }) },
  };
  const plan = await svc.generateMapping({ sourceSchema: { type: "object", additionalProperties: true }, targetSchema: target, sourceExamplePayload: payload });
  const executor = new TransformationExecutorService(validation, new LocationRegistry("data/locations/warehouses.json"));
  const r = await executor.executeWithOptions({
    sourcePayload: payload,
    plan,
    options: { validateTarget: { domain: "shipment", schemaName: "shipment-create-request" } },
  });
  return { c: r.targetPayload as Record<string, any>, validation: r.validation };
}

describe("SAP S/4HANA outbound delivery", () => {
  it("reads the destination from the ship-to partner (SH), not the first partner", async () => {
    const { c, validation } = await toCanonical((await loadJson("tests/fixtures/sap-outbound-delivery.json")) as Record<string, unknown>);
    assert.deepEqual(validation, { valid: true, errors: undefined });
    assert.equal(c.destination.city, "New York");
    assert.equal(c.destination.company, "Recipient Corp");
    assert.equal(c.destination.name, "Receiving Dept");
    assert.equal(c.destination.line1, "456 Customer Ave");
    assert.equal(c.destination.line2, undefined);
  });

  it("takes the origin from the shipping point in the location table", async () => {
    const { c } = await toCanonical((await loadJson("tests/fixtures/sap-outbound-delivery.json")) as Record<string, unknown>);
    assert.equal(c.extensions.originRef, "1710");
    assert.equal(c.origin.city, "Newtown Square");
  });

  it("picks a list item by field value, and reads SAP /Date(...)/", () => {
    const payload = { list: [{ f: "SP", v: 1 }, { f: "SH", v: 2 }] };
    assert.equal(getByPath(payload, "/list[f=SH]/v"), 2);
    assert.equal(getByPath(payload, "/list[f=XX]/v"), undefined);
    assert.equal(toCanonicalDateTimeString("/Date(1763164800000)/"), "2025-11-15T00:00:00.000Z");
  });
});
