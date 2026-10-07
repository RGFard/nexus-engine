/**
 * Global learned vocabulary — accept-and-remember loop for AI fallback mappings.
 *
 *   1. An AI-fallback mapping lands in GET /vocabulary/pending (heuristic ones don't).
 *   2. Accepting moves it into the global custom vocabulary.
 *   3. The same field then maps at confidence 1.0 with NO AI call, for any payload.
 *   4. Rejecting drops the entry and leaves heuristic/AI behavior unchanged.
 *   5. Carrier payloads (UPS/FedEx/EasyPost/DHL/ShipStation/ERP) are unaffected.
 *
 * Drives the real Fastify app via inject(); only the Anthropic client is stubbed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { loadJson } from "./helpers/load-schema.js";

// Must be set before the app modules (and their singletons) are imported.
const SECRET = "test-secret";
process.env.VOCAB_SECRET = SECRET;
process.env.ANTHROPIC_API_KEY = "stub";
delete process.env.AI_FALLBACK_THRESHOLD;
delete process.env.LEARNED_VOCAB_DIR;

const { buildApp } = await import("../src/app.js");
const { aiMappingService, AiMappingService } = await import("../src/ai/services/ai-mapping.service.js");
const { InMemoryLearnedVocabularyStore, learnedVocabularyStore, pendingId } = await import(
  "../src/ai/services/learned-vocabulary.store.js"
);
const { InMemoryVocabularyStore } = await import("../src/ai/services/custom-vocabulary.store.js");
const { loadAiConfig } = await import("../src/ai/config.js");
const { semanticMatcherService } = await import("../src/ai/services/semantic-matcher.service.js");
const { schemaRegistry } = await import("../src/services/schema-registry.service.js");

// ── Anthropic stub ───────────────────────────────────────────────────────────
// Returns whatever `aiResponse` holds; counts calls so tests can assert "no AI".
let aiCalls = 0;
let aiResponse: Array<Record<string, unknown>> = [];
(aiMappingService as unknown as { anthropic: unknown }).anthropic = {
  messages: {
    create: async () => {
      aiCalls++;
      return { content: [{ type: "text", text: JSON.stringify({ mappings: aiResponse }) }] };
    },
  },
};

const BASE = {
  origin: { line1: "123 Warehouse Rd", city: "Chicago", postalCode: "60601", countryCode: "US" },
  destination: { line1: "456 Customer Ave", city: "New York", postalCode: "10001", countryCode: "US" },
  packages: [{ weight: { value: 5.5, unit: "kg" } }],
};

const PHONE_AI = {
  sourceField: "/cnsgTelNo",
  targetField: "/destination/phone",
  confidence: 0.88,
  transformation: "cast:string",
  reasoning: "cnsgTelNo = consignee telephone number; value is a phone number.",
};
// AI typically echoes fields the heuristic already had — these must NOT be queued.
const HEURISTIC_ECHO = {
  sourceField: "/origin/city",
  targetField: "/origin/city",
  confidence: 0.99,
  transformation: "direct",
  reasoning: "Same name.",
};

let app: FastifyInstance;
const auth = { "x-vocabulary-secret": SECRET };

async function normalize(sourcePayload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/ai/normalize",
    payload: { sourcePayload, target: { domain: "shipment", schemaName: "shipment-create-request" } },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function listPending() {
  const res = await app.inject({ method: "GET", url: "/vocabulary/pending", headers: auth });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().pending as Array<Record<string, any>>;
}

before(async () => {
  app = await buildApp({ host: "127.0.0.1", port: 0, logLevel: "silent" });
});

after(async () => {
  await app.close();
});

describe("global learned vocabulary — accept-and-remember", () => {
  it("queues only AI-originated mappings in pending", async () => {
    aiResponse = [PHONE_AI, HEURISTIC_ECHO];
    const before = aiCalls;
    const res = await normalize({ ...BASE, cnsgTelNo: "+1 212 555 0100" });

    assert.equal(aiCalls - before, 1, "AI should be called for the unknown field");
    assert.equal(res.plan.metadata.aiEnhanced, true);

    const pending = await listPending();
    assert.deepEqual(
      pending.map((p) => `${p.sourceField} -> ${p.targetField}`),
      ["/cnsgTelNo -> /destination/phone"],
      "heuristic-echo mappings must not be queued",
    );
    const [p] = pending;
    assert.equal(p.id, pendingId("/cnsgTelNo", "/destination/phone"));
    assert.equal(p.transformation, "cast:string");
    assert.equal(p.confidence, 0.88);
    assert.match(p.reasoning, /consignee telephone/);
    assert.equal(p.context.targetSchemaId?.includes("shipment-create-request"), true);
    assert.equal(p.seenCount, 1);
  });

  it("re-sighting the same mapping bumps seenCount instead of duplicating", async () => {
    aiResponse = [PHONE_AI];
    await normalize({ ...BASE, cnsgTelNo: "+1 212 555 0199" });
    const pending = await listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].seenCount, 2);
  });

  it("accept moves the entry into custom vocabulary and empties pending", async () => {
    const id = pendingId("/cnsgTelNo", "/destination/phone");
    const res = await app.inject({ method: "POST", url: `/vocabulary/pending/${id}/accept`, headers: auth });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      { ...res.json().accepted, acceptedAt: undefined },
      {
        inputField: "/cnsgTelNo",
        canonicalField: "/destination/phone",
        transformation: "cast:string",
        acceptedAt: undefined,
      },
    );

    assert.equal((await listPending()).length, 0);
    const custom = await learnedVocabularyStore.loadCustom();
    assert.equal(custom.get("/cnsgTelNo")?.canonicalField, "/destination/phone");
  });

  it("rerun of the same payload maps the field with no AI call, at confidence 1.0", async () => {
    aiResponse = [];
    const before = aiCalls;
    const res = await normalize({ ...BASE, cnsgTelNo: "+1 212 555 0100" });

    assert.equal(aiCalls - before, 0, "AI must not be called");
    assert.equal(res.plan.metadata.aiEnhanced, false);
    assert.equal(res.plan.metadata.generationMode, "heuristic");
    const m = res.plan.mappings.find((x: any) => x.sourceField === "/cnsgTelNo");
    assert.equal(m?.targetField, "/destination/phone");
    assert.equal(m?.confidence, 1);
    assert.equal(m?.transformation, "cast:string");
    assert.equal(res.targetPayload.destination.phone, "+1 212 555 0100");
    assert.equal((await listPending()).length, 0, "vocabulary hits are never re-queued");
  });

  it("a different payload carrying the same field also skips AI", async () => {
    const before = aiCalls;
    const res = await normalize({
      origin: { line1: "1 Dock St", city: "Seattle", postalCode: "98101", countryCode: "US" },
      destination: { line1: "9 Elm Rd", city: "Austin", postalCode: "73301", countryCode: "US" },
      packages: [{ weight: { value: 2, unit: "lb" } }],
      cnsgTelNo: "+1 512 555 0101",
    });
    assert.equal(aiCalls - before, 0);
    assert.equal(res.plan.metadata.aiEnhanced, false);
    assert.equal(res.targetPayload.destination.phone, "+1 512 555 0101");
  });

  it("reject drops the pending entry, leaves vocabulary alone, and AI still handles the field", async () => {
    const EMAIL_AI = {
      sourceField: "/rcvrMl",
      targetField: "/destination/email",
      confidence: 0.8,
      transformation: "direct",
      reasoning: "Receiver mail address.",
    };
    aiResponse = [EMAIL_AI];
    const payload = { ...BASE, rcvrMl: "jane@example.com" };

    const first = await normalize(payload);
    assert.equal(first.plan.metadata.aiEnhanced, true);
    const id = pendingId("/rcvrMl", "/destination/email");
    assert.ok((await listPending()).some((p) => p.id === id));

    const customBefore = await learnedVocabularyStore.loadCustom();
    const res = await app.inject({ method: "POST", url: `/vocabulary/pending/${id}/reject`, headers: auth });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { rejected: id });

    assert.equal((await listPending()).length, 0);
    assert.deepEqual(await learnedVocabularyStore.loadCustom(), customBefore, "custom vocab untouched");

    // Rejected ≠ blocked: AI fallback behaves exactly as before.
    // (the in-process AI result cache may serve this — still the AI path)
    const again = await normalize(payload);
    assert.equal(again.plan.metadata.aiEnhanced, true);
    const m = again.plan.mappings.find((x: any) => x.sourceField === "/rcvrMl");
    assert.equal(m?.targetField, "/destination/email");
    assert.equal(m?.confidence, 0.8);
  });

  it("unknown id → 404; missing secret → 401", async () => {
    for (const action of ["accept", "reject"]) {
      const res = await app.inject({ method: "POST", url: `/vocabulary/pending/nope/${action}`, headers: auth });
      assert.equal(res.statusCode, 404);
    }
    assert.equal((await app.inject({ method: "GET", url: "/vocabulary/pending" })).statusCode, 401);
    const noAuth = await app.inject({ method: "POST", url: "/vocabulary/pending/x/accept" });
    assert.equal(noAuth.statusCode, 401);
  });
});

describe("exact-path matches and explicit-rule routes are never learned from AI", () => {
  it("ShipStation: AI can't re-route rule-routed top-level weight, and nothing weight-related is queued", async () => {
    const shipstation = await loadJson("tests/fixtures/shipstation-shipment.json");
    // Verbatim shape of what the live model proposed for this fixture.
    aiResponse = [
      { sourceField: "/weight/value", targetField: "/weight/value", confidence: 0.9, transformation: "direct", reasoning: "Same path." },
      { sourceField: "/weight/units", targetField: "/weight/unit", confidence: 0.9, transformation: "direct", reasoning: "Unit." },
      { sourceField: "/items[]/name", targetField: "/packages[]/description", confidence: 0.85, transformation: "array:map", reasoning: "Item name." },
    ];
    const before = aiCalls;
    const res = await normalize(shipstation);
    // AI still runs (twice: ShipStation has no ship-from, so the second pass fires too).
    assert.ok(aiCalls - before >= 1, "AI still runs for the genuinely missing fields");

    const bySource = (src: string) =>
      res.plan.mappings.filter((m: any) => m.sourceField === src).map((m: any) => m.targetField);
    assert.deepEqual(bySource("/weight/value"), ["/packages[]/weight/value"]);
    assert.deepEqual(bySource("/weight/units"), ["/packages[]/weight/unit"]);
    assert.ok(res.targetPayload.packages[0].weight, "required package weight must survive");
    assert.equal(res.targetPayload.packages[0].weight.value, 5.2);

    const pending = await listPending();
    assert.deepEqual(
      pending.filter((p) => p.sourceField.startsWith("/weight/")),
      [],
      "rule-routed / exact-path weight fields must never be queued",
    );
    // Unrelated AI gap-fills on the same request are still learned.
    assert.ok(pending.some((p) => p.sourceField === "/items[]/name"));
  });

  it("an AI-proposed exact-path pair is never queued, even when the heuristic left the source free", async () => {
    // Inline target with no /packages: the /weight/value rule has no target here, so
    // the heuristic doesn't route it and the AI's exact-path pair is applied — but
    // as an exact path it is not vocabulary and must not be queued.
    const targetSchema = {
      type: "object",
      properties: {
        weight: { type: "object", properties: { value: { type: "number" }, unit: { type: "string" } } },
        phone: { type: "string" },
      },
    };
    aiResponse = [
      { sourceField: "/weight/value", targetField: "/weight/value", confidence: 0.95, transformation: "direct", reasoning: "Same path." },
    ];
    const res = await app.inject({
      method: "POST",
      url: "/ai/normalize",
      payload: { sourcePayload: { weight: { value: 3, unit: "kg" }, telNo: "+1 212 555 0100" }, targetSchema },
    });
    assert.equal(res.statusCode, 200, res.body);
    const pending = await listPending();
    assert.equal(pending.some((p) => p.sourceField === "/weight/value"), false);
  });
});

describe("global learned vocabulary — precedence and carrier isolation", () => {
  const noAiConfig = () => ({ ...loadAiConfig(), anthropicApiKey: undefined });
  const requestSchema = () => schemaRegistry.get("shipment", "shipment-create-request")!.schema;

  async function plan(
    payload: Record<string, unknown>,
    learned: InstanceType<typeof InMemoryLearnedVocabularyStore>,
    perClient = new InMemoryVocabularyStore(),
    clientId?: string,
  ) {
    const svc = new AiMappingService(noAiConfig(), perClient, learned);
    return svc.generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(payload, "X"),
      targetSchema: requestSchema(),
      sourceExamplePayload: payload,
      options: { clientId },
    });
  }

  async function learnedWith(entries: Array<[string, string, string]>) {
    const store = new InMemoryLearnedVocabularyStore();
    await store.recordPending(
      entries.map(([sourceField, targetField, transformation]) => ({
        sourceField,
        targetField,
        transformation,
        confidence: 0.9,
        reasoning: "test",
        context: {},
      })),
    );
    for (const [s, t] of entries) await store.acceptPending(pendingId(s, t));
    return store;
  }

  it("per-client vocabulary wins over the global list on conflict", async () => {
    const learned = await learnedWith([["/cnsgTelNo", "/destination/phone", "direct"]]);
    const perClient = new InMemoryVocabularyStore();
    await perClient.accept("acme", [{ inputField: "cnsgTelNo", canonicalField: "/origin/phone" }]);

    const p = await plan({ ...BASE, cnsgTelNo: "+1 212 555 0100" }, learned, perClient, "acme");
    const hits = p.mappings.filter((m) => m.sourceField === "/cnsgTelNo");
    assert.deepEqual(hits.map((m) => m.targetField), ["/origin/phone"]);
  });

  it("UPS/FedEx/EasyPost/DHL/ShipStation/ERP plans are identical with a populated global list", async () => {
    const EASYPOST = {
      from_address: { street1: "1 Main St", city: "Boston", zip: "02108", country: "US" },
      to_address: { street1: "2 Pine St", city: "Denver", zip: "80202", country: "US" },
      parcel: { weight: 16, length: 10, width: 8, height: 4 },
    };
    const ERP = {
      NTGEW: "5.5", GEWEI: "KG", LFIMG: 3, ARKTX: "Widget part A", MATNR: "WIDGET-001",
      STRAS_S: "123 Warehouse Rd", ORT01_S: "Chicago", LAND1_S: "US",
      STRAS_E: "456 Customer Ave", ORT01_E: "New York", LAND1_E: "US",
    };
    const payloads: Record<string, Record<string, unknown>> = {
      ups: await loadJson("tests/fixtures/ups-shipment.json"),
      fedex: await loadJson("tests/fixtures/fedex-shipment.json"),
      dhl: await loadJson("tests/fixtures/dhl-shipment.json"),
      shipstation: await loadJson("tests/fixtures/shipstation-shipment.json"),
      easypost: EASYPOST,
      erp: ERP,
    };
    // Realistic learned entries for fields none of these payloads carry.
    const learned = await learnedWith([
      ["/cnsgTelNo", "/destination/phone", "cast:string"],
      ["/rcvrMl", "/destination/email", "direct"],
    ]);

    for (const [name, payload] of Object.entries(payloads)) {
      const baseline = await plan(payload, new InMemoryLearnedVocabularyStore());
      const withLearned = await plan(payload, learned);
      assert.deepEqual(withLearned.mappings, baseline.mappings, `${name}: mappings changed`);
      assert.deepEqual(withLearned.metadata, baseline.metadata, `${name}: metadata changed`);
      assert.deepEqual(
        withLearned.unmappedSourceFields,
        baseline.unmappedSourceFields,
        `${name}: unmapped changed`,
      );
    }
  });
});
