import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { InMemoryVocabularyStore } from "../src/ai/services/custom-vocabulary.store.js";
import { LocationRegistry } from "../src/ai/services/location-registry.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { loadJson } from "./helpers/load-schema.js";

// ShipStation v1 orders name a warehouse (advancedOptions.warehouseId) instead of sending
// a ship-from address; v2 shipments send either warehouse_id or a ship_from address.
// Heuristic only (no AI key), so these runs are deterministic.

const RENO = {
  company: "Test Warehouse",
  line1: "1200 Distribution Way",
  city: "Reno",
  stateOrProvince: "NV",
  postalCode: "89502",
  countryCode: "US",
};

function tableFile(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locations-"));
  const file = path.join(dir, "warehouses.json");
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

let requestSchema: Record<string, unknown>;
let validation: SchemaValidationService;
const mapper = new AiMappingService(
  {
    anthropicApiKey: undefined,
    anthropicModel: "test",
    anthropicMaxTokens: 100,
    mappingEnabled: true,
    aiFallbackEnabled: true,
    aiFallbackThreshold: 0.75,
    autoApplyThreshold: 0.45,
  },
  new InMemoryVocabularyStore(),
);

before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
  validation = new SchemaValidationService(schemaRegistry);
  await validation.initialize();
  requestSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;
});

async function normalize(fixture: string, locations?: LocationRegistry) {
  const payload = await loadJson(fixture);
  const plan = await mapper.generateMapping({
    sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "ShipStation"),
    targetSchema: requestSchema,
    sourceExamplePayload: payload,
  });
  const executor = new TransformationExecutorService(validation, locations);
  const result = await executor.executeWithOptions({
    sourcePayload: payload,
    plan,
    options: { validateTarget: { domain: "shipment", schemaName: "shipment-create-request" } },
  });
  return { plan, result, out: result.targetPayload as Record<string, any> };
}

describe("LocationRegistry", () => {
  it("fills a missing origin from the table and keeps originRef", () => {
    const reg = new LocationRegistry(tableFile({ "98765": RENO }));
    const payload: Record<string, any> = { extensions: { originRef: "98765" } };
    assert.deepEqual(reg.resolveOrigin(payload), { status: "resolved", ref: "98765" });
    assert.deepEqual(payload.origin, RENO);
    assert.equal(payload.extensions.originRef, "98765");
  });

  it("never overwrites an origin the source supplied", () => {
    const reg = new LocationRegistry(tableFile({ "98765": RENO }));
    const payload: Record<string, any> = {
      origin: { line1: "1 Real St", city: "Austin", countryCode: "US" },
      extensions: { originRef: "98765" },
    };
    assert.deepEqual(reg.resolveOrigin(payload), { status: "not-needed" });
    assert.equal(payload.origin.city, "Austin");
  });

  it("replaces a partial origin that has no street", () => {
    const reg = new LocationRegistry(tableFile({ "98765": RENO }));
    const payload: Record<string, any> = { origin: { stateOrProvince: "CA" }, extensions: { originRef: 98765 } };
    assert.equal(reg.resolveOrigin(payload).status, "resolved");
    assert.deepEqual(payload.origin, RENO);
  });

  it("reports an unknown warehouse and leaves origin empty", () => {
    const reg = new LocationRegistry(tableFile({ "98765": RENO }));
    const payload: Record<string, any> = { extensions: { originRef: "11111" } };
    assert.deepEqual(reg.resolveOrigin(payload), { status: "not-found", ref: "11111" });
    assert.equal(payload.origin, undefined);
  });

  it("works with no table file at all", () => {
    const reg = new LocationRegistry(path.join(os.tmpdir(), "does-not-exist", "warehouses.json"));
    assert.equal(reg.resolveOrigin({ extensions: { originRef: "1" } }).status, "not-found");
  });

  it("picks up edits to the table without a restart, and ignores _comment keys", async () => {
    const file = tableFile({ _comment: "x" });
    const reg = new LocationRegistry(file);
    assert.equal(reg.lookup("_comment"), undefined);
    assert.equal(reg.lookup("98765"), undefined);
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, JSON.stringify({ "98765": RENO }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(reg.lookup("98765"), RENO);
  });

  it("keeps the last good table when the file is broken", () => {
    const file = tableFile({ "98765": RENO });
    const reg = new LocationRegistry(file);
    assert.deepEqual(reg.lookup("98765"), RENO);
    fs.writeFileSync(file, "{ not json");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(reg.lookup("98765"), RENO);
  });
});

describe("ShipStation v1 (advancedOptions.warehouseId)", () => {
  it("is valid with the warehouse in the table", async () => {
    const { out, result } = await normalize(
      "tests/fixtures/shipstation-shipment.json",
      new LocationRegistry(tableFile({ "98765": RENO })),
    );
    assert.equal(result.validation?.valid, true, JSON.stringify(result.validation));
    assert.deepEqual(out.origin, RENO);
    assert.equal(out.extensions.originRef, "98765");
    assert.equal(out.destination.city, "Los Angeles");
  });

  it("names the unknown warehouse when it is not in the table", async () => {
    const { result } = await normalize(
      "tests/fixtures/shipstation-shipment.json",
      new LocationRegistry(tableFile({})),
    );
    assert.equal(result.validation?.valid, false);
    assert.deepEqual(result.validation?.errors?.[0], {
      instancePath: "/extensions/originRef",
      message: "warehouse 98765 is not in the location table",
    });
  });
});

describe("ShipStation v2", () => {
  it("warehouse_id only: origin comes from the table", async () => {
    const { out, result } = await normalize(
      "tests/fixtures/shipstation-v2-warehouse-shipment.json",
      new LocationRegistry(tableFile({ "se-277331": RENO })),
    );
    assert.equal(result.validation?.valid, true, JSON.stringify(result.validation));
    assert.deepEqual(out.origin, RENO);
    assert.equal(out.extensions.originRef, "se-277331");
  });

  it("ship_from address: mapped directly, table not used", async () => {
    const { out, result } = await normalize(
      "tests/fixtures/shipstation-v2-shipment.json",
      new LocationRegistry(tableFile({})),
    );
    assert.equal(result.validation?.valid, true, JSON.stringify(result.validation));
    assert.equal(out.origin.city, "Austin");
    assert.equal(out.origin.line1, "4009 Marathon Blvd");
    assert.equal(out.origin.stateOrProvince, "TX");
    assert.equal(out.destination.stateOrProvince, "CA");
  });

  it("packages nested inside shipments[] come out as an array, units normalized", async () => {
    const { out } = await normalize("tests/fixtures/shipstation-v2-shipment.json");
    assert.deepEqual(out.packages, [
      { dimensions: { height: 4, length: 12, unit: "in", width: 8 }, weight: { unit: "oz", value: 20 } },
    ]);
  });
});
