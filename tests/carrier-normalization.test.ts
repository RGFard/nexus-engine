import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferDeliveryDateTransformation } from "../src/ai/utils/date-normalize.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { loadJson } from "./helpers/load-schema.js";

const executor = new TransformationExecutorService();

async function buildPlanFromCarrier(
  carrierPayload: Record<string, unknown>,
  label: string,
) {
  const target = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");
  const sourceSchema = semanticMatcherService.inferSchemaFromPayload(carrierPayload, label);

  const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, carrierPayload);
  const targetAnalysis = semanticMatcherService.analyzeSchema(target);
  const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);

  return {
    mappings: candidates.map((c) => ({
      sourceField: c.sourceField,
      targetField: c.targetField,
      confidence: c.confidence,
      transformation:
        inferDeliveryDateTransformation(c.sourceField, c.targetField) ?? "direct",
      reasoning: c.reasoning ?? "",
    })),
    unmappedSourceFields: semanticMatcherService.findUnmapped(
      sourceAnalysis,
      new Set(candidates.map((c) => c.sourceField)),
    ),
    unmappedTargetFields: semanticMatcherService.findUnmapped(
      targetAnalysis,
      new Set(candidates.map((c) => c.targetField)),
    ),
  };
}

describe("carrier payload normalization (heuristic)", () => {
  it("normalizes FedEx payload to canonical tracking and delivery fields", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const plan = await buildPlanFromCarrier(fedex, "FedEx");

    assert.ok(plan.mappings.length >= 2, "expected multiple mappings");

    const result = await executor.executeWithOptions({
      sourcePayload: fedex,
      plan,
      options: { minConfidence: 0.5 },
    });

    const target = result.targetPayload as Record<string, unknown>;
    const tracking = target.trackingNumber ?? (target.identifiers as Record<string, unknown>)?.masterTrackingNumber;
    assert.ok(tracking, "expected tracking on target payload");
    assert.equal(tracking, fedex.masterTrackingNumber);
  });

  it("normalizes UPS payload with ShipmentIdentificationNumber", async () => {
    const ups = await loadJson("tests/fixtures/ups-shipment.json");
    const plan = await buildPlanFromCarrier(ups, "UPS");

    const trackingMapping = plan.mappings.find((m) => m.targetField.includes("trackingNumber"));
    assert.ok(trackingMapping, "UPS tracking mapping required");

    const result = await executor.executeWithOptions({
      sourcePayload: ups,
      plan,
      options: { minConfidence: 0.5 },
    });

    const target = result.targetPayload as Record<string, unknown>;
    assert.equal(target.trackingNumber, ups.ShipmentIdentificationNumber);
  });

  it("normalizes DHL payload with shipmentTrackingNumber", async () => {
    const dhl = await loadJson("tests/fixtures/dhl-shipment.json");
    const plan = await buildPlanFromCarrier(dhl, "DHL");

    const trackingMapping = plan.mappings.find((m) => m.targetField.includes("trackingNumber"));
    assert.ok(trackingMapping);

    const result = await executor.executeWithOptions({
      sourcePayload: dhl,
      plan,
      options: { minConfidence: 0.5 },
    });

    const target = result.targetPayload as Record<string, unknown>;
    assert.equal(target.trackingNumber, dhl.shipmentTrackingNumber);
  });

  it("normalizes FedEx transaction response with nested transactionShipments[]", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-transaction-response.json");
    const plan = await buildPlanFromCarrier(fedex, "FedEx");

    const trackingMapping = plan.mappings.find(
      (m) =>
        m.sourceField.includes("masterTrackingNumber") &&
        m.targetField.includes("trackingNumber"),
    );
    const deliveryMapping = plan.mappings.find(
      (m) =>
        m.sourceField.toLowerCase().includes("estimateddeliverytimestamp") &&
        m.targetField.includes("/estimatedDelivery/dateTime"),
    );

    assert.ok(trackingMapping, "expected masterTrackingNumber -> trackingNumber");
    assert.ok(deliveryMapping, "expected estimatedDeliveryTimestamp -> dateTime");

    const result = await executor.executeWithOptions({
      sourcePayload: fedex,
      plan,
      options: { minConfidence: 0.5 },
    });

    assert.ok(
      result.appliedMappings.length >= 2,
      `expected applied mappings, got skipped: ${result.skippedMappings.map((m) => m.sourceField).join(", ")}`,
    );
    assert.equal(result.skippedMappings.length, 0);

    const target = result.targetPayload as Record<string, unknown>;
    assert.equal(target.trackingNumber, "FedEx-1007");

    const estimated = target.estimatedDelivery as Record<string, unknown>;
    assert.ok(estimated);
    assert.equal(estimated.dateTime, "2026-05-30T17:00:00.000Z");
  });

  it("includes reasoning on every mapping", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const plan = await buildPlanFromCarrier(fedex, "FedEx");

    for (const m of plan.mappings) {
      assert.ok(m.reasoning.length > 5, `missing reasoning for ${m.sourceField}`);
    }
  });
});
