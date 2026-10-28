import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { aiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { loadJson } from "./helpers/load-schema.js";

// FedEx requires a phone for both parties, so the heuristic must find carrier phones
// without relying on the AI fallback.

let target: Record<string, unknown>;
before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
  target = (await loadJson("src/schemas/shipment/shipment-create-request.schema.json")) as Record<string, unknown>;
});

async function phoneMappings(payload: Record<string, unknown>) {
  const plan = await aiMappingService.generateMapping({
    sourceSchema: { type: "object", additionalProperties: true },
    targetSchema: target,
    sourceExamplePayload: payload,
  });
  return Object.fromEntries(
    plan.mappings.filter((m) => /\/phone$/.test(m.targetField)).map((m) => [m.targetField, m.sourceField]),
  );
}

describe("contact phone mapping", () => {
  it("maps UPS Phone/Number under ShipFrom and ShipTo", async () => {
    const ups = (await loadJson("tests/fixtures/ups-shipment.json")) as Record<string, any>;
    ups.ShipFrom.Phone = { Number: "5025550100" };
    ups.ShipTo.Phone = { Number: "5025550101" };
    assert.deepEqual(await phoneMappings(ups), {
      "/origin/phone": "/ShipFrom/Phone/Number",
      "/destination/phone": "/ShipTo/Phone/Number",
    });
  });

  it("maps EasyPost from_address and to_address phone", async () => {
    const ep = (await loadJson("tests/fixtures/easypost-shipment.json")) as Record<string, any>;
    ep.from_address.phone = "6175550100";
    ep.to_address.phone = "6175550101";
    assert.deepEqual(await phoneMappings(ep), {
      "/origin/phone": "/from_address/phone",
      "/destination/phone": "/to_address/phone",
    });
  });
});
