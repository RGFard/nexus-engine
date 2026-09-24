import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { applyTransformationSteps } from "../src/ai/services/transformation-engine.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import {
  inferDeliveryDateTransformation,
  parseCarrierDate,
  toCanonicalDateString,
  toCanonicalDateTimeString,
} from "../src/ai/utils/date-normalize.js";
import { loadJson } from "./helpers/load-schema.js";
import type { FieldMapping } from "../src/ai/models/mapping.types.js";

const validationService = new SchemaValidationService(schemaRegistry);
const executor = new TransformationExecutorService(validationService);

before(async () => {
  await schemaRegistry.initialize();
  await validationService.initialize();
});

describe("date-normalize utilities", () => {
  it("parses UPS YYYYMMDD compact dates", () => {
    const date = parseCarrierDate("20260530");
    assert.ok(date);
    assert.equal(toCanonicalDateString("20260530"), "2026-05-30");
    assert.equal(toCanonicalDateTimeString("20260530"), "2026-05-30T00:00:00.000Z");
  });

  it("parses DHL YYYY-MM-DD dates", () => {
    assert.equal(toCanonicalDateString("2026-05-30"), "2026-05-30");
    assert.equal(toCanonicalDateTimeString("2026-05-30"), "2026-05-30T00:00:00.000Z");
  });

  it("parses FedEx ISO estimatedDeliveryTimestamp", () => {
    const fedexTs = "2026-05-30T17:00:00.000Z";
    assert.equal(toCanonicalDateString(fedexTs), "2026-05-30");
    assert.equal(toCanonicalDateTimeString(fedexTs), "2026-05-30T17:00:00.000Z");
  });

  it("infers date:date for estimatedDelivery.date targets", () => {
    assert.equal(
      inferDeliveryDateTransformation(
        "/DeliveryDateInformation/DeliveryDate",
        "/estimatedDelivery/date",
      ),
      "direct|date:date",
    );
  });

  it("infers date:iso8601 for estimatedDelivery.dateTime targets", () => {
    assert.equal(
      inferDeliveryDateTransformation(
        "/estimatedDeliveryTimestamp",
        "/estimatedDelivery/dateTime",
      ),
      "direct|date:iso8601",
    );
  });
});

describe("carrier delivery date transformation", () => {
  it("normalizes UPS DeliveryDate to estimatedDelivery.date", async () => {
    const ups = await loadJson("tests/fixtures/ups-shipment.json");
    const mapping: FieldMapping = {
      sourceField: "/DeliveryDateInformation/DeliveryDate",
      targetField: "/estimatedDelivery/date",
      confidence: 0.9,
      transformation: "direct|date:date",
      reasoning: "UPS scheduled delivery date",
    };

    const sourceValue = ups.DeliveryDateInformation.DeliveryDate;
    const result = applyTransformationSteps(sourceValue, mapping.transformation, {
      sourcePayload: ups,
      mapping,
    });

    assert.equal(result, "2026-05-30");

    const execution = await executor.executeWithOptions({
      sourcePayload: ups,
      plan: { mappings: [mapping], unmappedSourceFields: [], unmappedTargetFields: [] },
      options: {
        validateTarget: {
          domain: "shipment",
          schemaName: "shipment-create-response",
          version: "2.1.0",
        },
      },
    });

    const estimated = (execution.targetPayload as Record<string, unknown>).estimatedDelivery as
      | Record<string, unknown>
      | undefined;
    assert.equal(estimated?.date, "2026-05-30");
    assert.equal(execution.validation?.valid, true, JSON.stringify(execution.validation?.errors));
  });

  it("normalizes DHL estimatedDeliveryDate to estimatedDelivery.date", async () => {
    const dhl = await loadJson("tests/fixtures/dhl-shipment.json");
    const mapping: FieldMapping = {
      sourceField: "/estimatedDeliveryDate",
      targetField: "/estimatedDelivery/date",
      confidence: 0.9,
      transformation: "direct|date:date",
      reasoning: "DHL estimated delivery date",
    };

    const result = applyTransformationSteps(dhl.estimatedDeliveryDate, mapping.transformation, {
      sourcePayload: dhl,
      mapping,
    });
    assert.equal(result, "2026-05-30");

    const execution = await executor.executeWithOptions({
      sourcePayload: dhl,
      plan: { mappings: [mapping], unmappedSourceFields: [], unmappedTargetFields: [] },
      options: {
        validateTarget: {
          domain: "shipment",
          schemaName: "shipment-create-response",
          version: "2.1.0",
        },
      },
    });

    const estimated = (execution.targetPayload as Record<string, unknown>).estimatedDelivery as
      | Record<string, unknown>
      | undefined;
    assert.equal(estimated?.date, "2026-05-30");
    assert.equal(execution.validation?.valid, true);
  });

  it("normalizes FedEx estimatedDeliveryTimestamp to estimatedDelivery.dateTime", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const mapping: FieldMapping = {
      sourceField: "/estimatedDeliveryTimestamp",
      targetField: "/estimatedDelivery/dateTime",
      confidence: 0.92,
      transformation: "direct|date:iso8601",
      reasoning: "FedEx estimated delivery timestamp",
    };

    const result = applyTransformationSteps(
      fedex.estimatedDeliveryTimestamp,
      mapping.transformation,
      { sourcePayload: fedex, mapping },
    );
    assert.equal(result, "2026-05-30T17:00:00.000Z");

    const execution = await executor.executeWithOptions({
      sourcePayload: fedex,
      plan: { mappings: [mapping], unmappedSourceFields: [], unmappedTargetFields: [] },
      options: {
        validateTarget: {
          domain: "shipment",
          schemaName: "shipment-create-response",
          version: "2.1.0",
        },
      },
    });

    const estimated = (execution.targetPayload as Record<string, unknown>).estimatedDelivery as
      | Record<string, unknown>
      | undefined;
    assert.equal(estimated?.dateTime, "2026-05-30T17:00:00.000Z");
    assert.equal(execution.validation?.valid, true);
  });

  it("maps UPS delivery date via heuristic matcher with valid schema output", async () => {
    const ups = await loadJson("tests/fixtures/ups-shipment.json");
    const targetSchema = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");

    const candidates = semanticMatcherService.findCandidateMappings(
      semanticMatcherService.analyzeSchema(
        semanticMatcherService.inferSchemaFromPayload(ups, "UPS"),
        ups,
      ),
      semanticMatcherService.analyzeSchema(targetSchema),
    );

    const delivery = candidates.find((c) => c.targetField === "/estimatedDelivery/date");
    assert.ok(delivery, "expected UPS delivery date mapping");

    const transformation =
      inferDeliveryDateTransformation(delivery.sourceField, delivery.targetField) ?? "direct";

    const execution = await executor.executeWithOptions({
      sourcePayload: ups,
      plan: {
        mappings: [
          {
            sourceField: delivery.sourceField,
            targetField: delivery.targetField,
            confidence: delivery.confidence,
            transformation,
            reasoning: delivery.reasoning ?? "",
          },
        ],
        unmappedSourceFields: [],
        unmappedTargetFields: [],
      },
      options: {
        validateTarget: {
          domain: "shipment",
          schemaName: "shipment-create-response",
          version: "2.1.0",
        },
      },
    });

    const estimated = (execution.targetPayload as Record<string, unknown>).estimatedDelivery as
      | Record<string, unknown>
      | undefined;
    assert.equal(estimated?.date, "2026-05-30");
    assert.equal(execution.validation?.valid, true);
  });
});
