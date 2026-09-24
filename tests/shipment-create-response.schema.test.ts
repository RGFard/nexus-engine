import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { applyCanonicalDefaults } from "../src/ai/utils/canonical-defaults.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { loadJson } from "./helpers/load-schema.js";

const validationService = new SchemaValidationService(schemaRegistry);
const executor = new TransformationExecutorService(validationService);

before(async () => {
  await schemaRegistry.initialize();
  await validationService.initialize();
});

async function normalizeFedexToTarget(
  fedexPath: string,
  options?: { applyCanonicalDefaults?: boolean },
) {
  const fedex = await loadJson(fedexPath);
  const targetSchema = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");
  const plan = {
    mappings: semanticMatcherService
      .findCandidateMappings(
        semanticMatcherService.analyzeSchema(
          semanticMatcherService.inferSchemaFromPayload(fedex, "Carrier"),
          fedex,
        ),
        semanticMatcherService.analyzeSchema(targetSchema),
      )
      .map((c) => ({
        sourceField: c.sourceField,
        targetField: c.targetField,
        confidence: c.confidence,
        transformation: "direct",
        reasoning: c.reasoning ?? "",
      })),
    unmappedSourceFields: [],
    unmappedTargetFields: [],
  };

  return executor.executeWithOptions({
    sourcePayload: fedex,
    plan,
    options: {
      validateTarget: { domain: "shipment", schemaName: "shipment-create-response", version: "2.1.0" },
      applyCanonicalDefaults: options?.applyCanonicalDefaults ?? false,
      targetSchemaForDefaults: targetSchema,
    },
  });
}

describe("shipment-create-response schema", () => {
  it("has no required root fields (carrier-safe)", async () => {
    const schema = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");
    assert.deepEqual(schema.required ?? [], []);
    assert.equal(schema["x-canonical-version"], "2.1.0");
  });

  it("validates carrier-normalized FedEx payload without platform fields", async () => {
    const result = await normalizeFedexToTarget("tests/fixtures/fedex-shipment.json");
    assert.equal(result.validation?.valid, true, JSON.stringify(result.validation?.errors));
    const target = result.targetPayload as Record<string, unknown>;
    assert.ok(target.trackingNumber);
    assert.equal(target.shipmentId, undefined);
    assert.equal(target.status, undefined);
    assert.equal(target.createdAt, undefined);
  });

  it("validates FedEx transaction response with tracking and delivery only", async () => {
    const result = await normalizeFedexToTarget(
      "tests/fixtures/fedex-transaction-response.json",
    );
    assert.equal(result.validation?.valid, true, JSON.stringify(result.validation?.errors));
    const target = result.targetPayload as Record<string, unknown>;
    assert.equal(target.trackingNumber, "FedEx-1007");
  });

  it("synthesizes platform defaults when applyCanonicalDefaults is enabled", async () => {
    const target: Record<string, unknown> = { trackingNumber: "1Z999AA10123456784" };
    const schema = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");
    const filled = applyCanonicalDefaults(target, schema);

    assert.ok(filled.includes("/shipmentId"));
    assert.ok(filled.includes("/status"));
    assert.ok(filled.includes("/createdAt"));
    assert.equal(target.shipmentId, "1Z999AA10123456784");
    assert.equal(target.status, "created");
    assert.ok(typeof target.createdAt === "string");
  });
});
