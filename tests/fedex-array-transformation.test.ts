import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { resolveMappingSourceValue } from "../src/ai/utils/json-path.js";
import { loadJson } from "./helpers/load-schema.js";

const executor = new TransformationExecutorService();

describe("array path transformation", () => {
  it("extracts scalar from /output/transactionShipments[]/masterTrackingNumber", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-transaction-response.json");
    const value = resolveMappingSourceValue(
      fedex,
      "/output/transactionShipments[]/masterTrackingNumber",
      "/trackingNumber",
    );
    assert.equal(value, "FedEx-1007");
  });

  it("extracts scalar from /output/transactionShipments[]/estimatedDeliveryTimestamp", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-transaction-response.json");
    const value = resolveMappingSourceValue(
      fedex,
      "/output/transactionShipments[]/estimatedDeliveryTimestamp",
      "/estimatedDelivery/dateTime",
    );
    assert.equal(value, "2026-05-30T17:00:00.000Z");
  });

  it("applies FedEx transaction mappings to canonical response", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-transaction-response.json");

    const plan = {
      mappings: [
        {
          sourceField: "/output/transactionShipments[]/masterTrackingNumber",
          targetField: "/trackingNumber",
          confidence: 0.94,
          transformation: "array:first|direct",
          reasoning: "Primary tracking number from first transaction shipment.",
        },
        {
          sourceField: "/output/transactionShipments[]/estimatedDeliveryTimestamp",
          targetField: "/estimatedDelivery/dateTime",
          confidence: 0.92,
          transformation: "array:first|direct|date:iso8601",
          reasoning: "Estimated delivery timestamp from first transaction shipment.",
        },
      ],
      unmappedSourceFields: [],
      unmappedTargetFields: [],
    };

    const result = await executor.executeWithOptions({
      sourcePayload: fedex,
      plan,
      options: { minConfidence: 0.5 },
    });

    assert.equal(result.appliedMappings.length, 2, "both mappings should apply");
    assert.equal(result.skippedMappings.length, 0);

    const target = result.targetPayload as Record<string, unknown>;
    assert.equal(target.trackingNumber, "FedEx-1007");

    const estimated = target.estimatedDelivery as Record<string, unknown>;
    assert.ok(estimated);
    assert.equal(estimated.dateTime, "2026-05-30T17:00:00.000Z");
  });

  it("applies direct transform when scalar unwrap handles array wildcard source", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-transaction-response.json");

    const result = await executor.executeWithOptions({
      sourcePayload: fedex,
      plan: {
        mappings: [
          {
            sourceField: "/output/transactionShipments[]/masterTrackingNumber",
            targetField: "/trackingNumber",
            confidence: 0.94,
            transformation: "direct",
            reasoning: "Scalar unwrap at source resolution",
          },
        ],
        unmappedSourceFields: [],
        unmappedTargetFields: [],
      },
    });

    assert.equal(result.appliedMappings.length, 1);
    assert.equal(result.skippedMappings.length, 0);
    assert.equal((result.targetPayload as Record<string, unknown>).trackingNumber, "FedEx-1007");
  });

  it("skips mapping when source path is missing from payload", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-transaction-response.json");

    const result = await executor.executeWithOptions({
      sourcePayload: fedex,
      plan: {
        mappings: [
          {
            sourceField: "/output/transactionShipments[]/nonexistentField",
            targetField: "/trackingNumber",
            confidence: 0.94,
            transformation: "direct",
            reasoning: "Missing source field",
          },
        ],
        unmappedSourceFields: [],
        unmappedTargetFields: [],
      },
    });

    assert.equal(result.appliedMappings.length, 0);
    assert.equal(result.skippedMappings.length, 1);
    assert.deepEqual(result.targetPayload, {});
  });
});
