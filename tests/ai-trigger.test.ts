import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { AiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { InMemoryLearnedVocabularyStore } from "../src/ai/services/learned-vocabulary.store.js";
import { InMemoryVocabularyStore } from "../src/ai/services/custom-vocabulary.store.js";
import { loadAiConfig } from "../src/ai/config.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { loadJson } from "./helpers/load-schema.js";

// When the AI is NOT asked: warehouse-sourced origins, and fields it already found no home for.

let target: Record<string, unknown>;
let aiCalls = 0;
let aiResponse: Array<Record<string, unknown>> = [];

function service(learned: InMemoryLearnedVocabularyStore) {
  const config = { ...loadAiConfig(), anthropicApiKey: undefined, mappingEnabled: true, aiFallbackEnabled: true, aiFallbackThreshold: 0.75 };
  const svc = new AiMappingService(config, new InMemoryVocabularyStore(), learned);
  (svc as unknown as { anthropic: unknown }).anthropic = {
    messages: {
      create: async () => {
        aiCalls++;
        return { content: [{ type: "text", text: JSON.stringify({ mappings: aiResponse }) }] };
      },
    },
  };
  return svc;
}

function plan(svc: AiMappingService, payload: Record<string, unknown>) {
  return svc.generateMapping({
    sourceSchema: { type: "object", additionalProperties: true },
    targetSchema: target,
    sourceExamplePayload: payload,
  });
}

before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
  target = (await loadJson("src/schemas/shipment/shipment-create-request.schema.json")) as Record<string, unknown>;
});

describe("AI trigger", () => {
  it("does not ask the AI for an origin that comes from the warehouse table", async () => {
    aiCalls = 0;
    aiResponse = [];
    const v2 = (await loadJson("tests/fixtures/shipstation-v2-warehouse-shipment.json")) as Record<string, unknown>;
    await plan(service(new InMemoryLearnedVocabularyStore()), v2);
    assert.equal(aiCalls, 0);
  });

  it("asks twice about a field with no canonical home, then remembers", async () => {
    const payload = {
      origin: { line1: "123 Warehouse Rd", city: "Chicago", postalCode: "60601", countryCode: "US" },
      destination: { line1: "456 Customer Ave", city: "New York", postalCode: "10001", countryCode: "US" },
      packages: [{ weight: { value: 5.5, unit: "kg" } }],
      billTo: { name: "Accounts Payable" },
    };
    // The AI answers, but places nothing for /billTo/name.
    aiResponse = [{ sourceField: "/origin/city", targetField: "/origin/city", confidence: 0.9, transformation: "direct", reasoning: "x" }];
    const learned = new InMemoryLearnedVocabularyStore();

    aiCalls = 0;
    await plan(service(learned), payload);
    assert.equal(aiCalls, 1, "first time: the AI is asked");
    assert.deepEqual((await learned.listNoHome()).map((e) => e.sourceField), ["/billTo/name"]);

    aiCalls = 0;
    await plan(service(learned), payload); // a fresh service: no in-memory cache
    assert.equal(aiCalls, 1, "second time: still asked, one miss is not enough");

    aiCalls = 0;
    await plan(service(learned), payload);
    assert.equal(aiCalls, 0, "third time: missed twice, remembered as no home");
  });

  it("records nothing when the AI returns an empty answer (it may have failed)", async () => {
    aiResponse = [];
    const learned = new InMemoryLearnedVocabularyStore();
    await plan(service(learned), {
      origin: { line1: "1 A St", city: "Chicago", postalCode: "60601", countryCode: "US" },
      destination: { line1: "2 B St", city: "New York", postalCode: "10001", countryCode: "US" },
      packages: [{ weight: { value: 1, unit: "kg" } }],
      billTo: { name: "Accounts Payable" },
    });
    assert.deepEqual(await learned.listNoHome(), []);
  });

  it("does not ask the AI for units a shipment-level unit system will fill", async () => {
    aiCalls = 0;
    aiResponse = [];
    await plan(service(new InMemoryLearnedVocabularyStore()), {
      origin: { line1: "123 Warehouse Rd", city: "Chicago", postalCode: "60601", countryCode: "US" },
      destination: { line1: "456 Customer Ave", city: "New York", postalCode: "10001", countryCode: "US" },
      packages: [{ weight: { value: 5.5 } }],
      unitOfMeasurement: "metric",
    });
    assert.equal(aiCalls, 0);
  });

  it("queues a weak guess the AI confirmed, so it can be learned", async () => {
    const easypost = (await loadJson("tests/fixtures/easypost-shipment.json")) as Record<string, unknown>;
    aiResponse = [
      { sourceField: "/from_address/street1", targetField: "/origin/line1", confidence: 0.95, transformation: "direct|cast:string", reasoning: "street1 is address line 1" },
    ];
    const learned = new InMemoryLearnedVocabularyStore();
    aiCalls = 0;
    await plan(service(learned), easypost);
    assert.equal(aiCalls, 1);
    const pending = await learned.listPending();
    assert.ok(
      pending.some((e) => e.sourceField === "/from_address/street1" && e.targetField === "/origin/line1"),
      JSON.stringify(pending.map((e) => e.sourceField)),
    );
    // A strong heuristic mapping the AI did not mention is not queued.
    assert.ok(!pending.some((e) => e.sourceField === "/from_address/city"));
  });
});
