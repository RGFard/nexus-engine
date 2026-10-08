/**
 * Customs line item siblings — DHL international commodity fields.
 *
 * A commodity field like /InternationalDetail/Commodities/Quantity legitimately feeds
 * BOTH /packages[]/quantity and the required /customs/lineItems[]/quantity, but
 * deduplicateBySource keeps one target per source. Which one survived depended on
 * relative heuristic/AI confidence, so the required line item quantity went missing
 * on some runs. The line item side must be present regardless of which target wins.
 *
 * Drives the real Fastify app via inject(); only the Anthropic client is stubbed so
 * each dedup outcome can be forced deterministically.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { loadJson } from "./helpers/load-schema.js";

process.env.ANTHROPIC_API_KEY = "stub";
delete process.env.LEARNED_VOCAB_DIR;

const { buildApp } = await import("../src/app.js");
const { aiMappingService } = await import("../src/ai/services/ai-mapping.service.js");

const C = "/InternationalDetail/Commodities";
let aiResponse: Array<Record<string, unknown>> = [];
(aiMappingService as unknown as { anthropic: unknown }).anthropic = {
  messages: {
    create: async () => ({ content: [{ type: "text", text: JSON.stringify({ mappings: aiResponse }) }] }),
  },
};
// Each test proposes different AI output for the same source paths — bypass the AI cache.
const clearAiCache = () =>
  (aiMappingService as unknown as { mappingCache: Map<string, unknown> }).mappingCache.clear();

const ai = (sourceField: string, targetField: string, confidence = 0.9, transformation = "direct") => ({
  sourceField, targetField, confidence, transformation, reasoning: "stub",
});

// What the live model proposed for the line item fields on this payload.
const LINE_ITEM_AI = [
  ai(`${C}/HarmonizedCode`, "/customs/lineItems[]/hsCode", 0.95),
  ai(`${C}/UnitPrice`, "/customs/lineItems[]/unitValue/amount", 0.88),
  ai(`${C}/CountryOfManufacture`, "/customs/lineItems[]/countryOfOrigin", 0.85),
];

let app: FastifyInstance;
let dhl: Record<string, unknown>;

async function normalize(sourcePayload: Record<string, unknown>) {
  clearAiCache();
  const res = await app.inject({
    method: "POST",
    url: "/ai/normalize",
    payload: { sourcePayload, target: { domain: "shipment", schemaName: "shipment-create-request" } },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

const targetsOf = (plan: any, source: string): string[] =>
  plan.mappings.filter((m: any) => m.sourceField === source).map((m: any) => m.targetField).sort();

before(async () => {
  app = await buildApp({ host: "127.0.0.1", port: 0, logLevel: "silent" });
  dhl = await loadJson("tests/fixtures/dhl-international-shipment.json");
});

after(async () => {
  await app.close();
});

describe("customs line item siblings (DHL international)", () => {
  it("quantity reaches the line item when /packages[]/quantity wins dedup (the reported failure)", async () => {
    aiResponse = [...LINE_ITEM_AI, ai(`${C}/Quantity`, "/packages[]/quantity", 0.95)];
    const res = await normalize(dhl);

    assert.deepEqual(targetsOf(res.plan, `${C}/Quantity`), ["/customs/lineItems[]/quantity", "/packages[]/quantity"]);
    assert.equal(res.targetPayload.customs.lineItems[0].quantity, 10);
    assert.equal(res.targetPayload.packages[0].quantity, 10);
    assert.equal(res.validation.valid, true, JSON.stringify(res.validation.errors));
  });

  it("no duplicate when the line item quantity already won dedup", async () => {
    aiResponse = [...LINE_ITEM_AI, ai(`${C}/Quantity`, "/customs/lineItems[]/quantity", 0.95)];
    const res = await normalize(dhl);

    const qtyMappings = res.plan.mappings.filter((m: any) => m.targetField === "/customs/lineItems[]/quantity");
    assert.equal(qtyMappings.length, 1);
    assert.equal(res.targetPayload.customs.lineItems[0].quantity, 10);
    assert.equal(res.validation.valid, true, JSON.stringify(res.validation.errors));
  });

  it("description dual-mapping is unchanged", async () => {
    aiResponse = [...LINE_ITEM_AI, ai(`${C}/Description`, "/packages[]/description", 0.95)];
    const res = await normalize(dhl);

    assert.ok(targetsOf(res.plan, `${C}/Description`).includes("/customs/lineItems[]/description"));
    assert.equal(res.targetPayload.customs.lineItems[0].description, "Cotton T-shirts");
    const synthesized = res.plan.mappings.find(
      (m: any) => m.targetField === "/customs/lineItems[]/description",
    );
    // enforceScalarCastTransformation appends cast:string to every string-only target
    // (description is `type: "string"`), so the base step is still "direct" — just no
    // longer bare. Value and confidence are what this test actually guards.
    assert.equal(synthesized.transformation, "direct|cast:string");
    assert.equal(synthesized.confidence, 0.85);
  });

  it("a numeric field AI maps 'direct' onto a string-only target still lands as a string", async () => {
    // Reproduces the live bug: AI proposed /shipments[]/shipmentId -> /identifiers/shipmentId
    // as "direct" with reasoning "already string in target" (confidence 0.92), but the
    // source value was actually numeric, so it landed as a bare number and failed ajv's
    // string|null check. enforceScalarCastTransformation is the schema-driven safety net —
    // it doesn't trust the AI's reasoning text, it reads the target's actual allowed type.
    aiResponse = [
      ...LINE_ITEM_AI,
      ai(`${C}/Quantity`, "/identifiers/shipmentId", 0.92, "direct"),
    ];
    const res = await normalize(dhl);

    const shipmentIdMapping = res.plan.mappings.find((m: any) => m.targetField === "/identifiers/shipmentId");
    assert.ok(shipmentIdMapping, "/identifiers/shipmentId must be in plan.mappings");
    assert.equal(shipmentIdMapping.transformation, "direct|cast:string");
    assert.equal(typeof res.targetPayload.identifiers.shipmentId, "string");
    assert.equal(res.validation.valid, true, JSON.stringify(res.validation.errors));
  });

  it("string quantities are cast to the integer the schema requires", async () => {
    const payload = structuredClone(dhl) as any;
    payload.InternationalDetail.Commodities.Quantity = "10";
    aiResponse = [...LINE_ITEM_AI, ai(`${C}/Quantity`, "/packages[]/quantity", 0.95)];
    const res = await normalize(payload);

    assert.equal(res.targetPayload.customs.lineItems[0].quantity, 10);
    assert.equal(typeof res.targetPayload.customs.lineItems[0].quantity, "number");
  });

  it("no line item quantity is invented when no customs line item fields mapped", async () => {
    const domestic = structuredClone(dhl) as any;
    delete domestic.InternationalDetail;
    aiResponse = [];
    const res = await normalize(domestic);
    assert.equal(
      res.plan.mappings.some((m: any) => m.targetField.startsWith("/customs/lineItems[]/")),
      false,
    );
  });
});
