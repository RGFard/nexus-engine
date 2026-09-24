import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { computeSemanticSimilarity } from "../src/ai/utils/semantic-scoring.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { loadJson } from "./helpers/load-schema.js";

const executor = new TransformationExecutorService();

describe("semantic field matching", () => {
  it("maps masterTrackingNumber to trackingNumber by meaning", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const target = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(fedex, "FedEx");

    const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, fedex);
    const targetAnalysis = semanticMatcherService.analyzeSchema(target);

    const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);
    const tracking = candidates.find(
      (c) =>
        c.sourceField.toLowerCase().includes("mastertracking") &&
        c.targetField.includes("trackingNumber"),
    );

    assert.ok(tracking, "expected masterTrackingNumber → trackingNumber mapping");
    assert.ok(tracking.confidence >= 0.7);
    assert.ok(tracking.reasoning && tracking.reasoning.length > 10);
  });

  it("maps UPS ShipmentIdentificationNumber to trackingNumber", async () => {
    const ups = await loadJson("tests/fixtures/ups-shipment.json");
    const target = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ups, "UPS");

    const candidates = semanticMatcherService.findCandidateMappings(
      semanticMatcherService.analyzeSchema(sourceSchema, ups),
      semanticMatcherService.analyzeSchema(target),
    );

    const tracking = candidates.find(
      (c) =>
        c.sourceField.toLowerCase().includes("shipmentidentification") &&
        c.targetField.includes("trackingNumber"),
    );
    assert.ok(tracking);
    assert.ok(tracking.confidence >= 0.7);
  });

  it("maps estimatedDeliveryTimestamp to estimated delivery fields", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const target = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(fedex, "FedEx");

    const candidates = semanticMatcherService.findCandidateMappings(
      semanticMatcherService.analyzeSchema(sourceSchema, fedex),
      semanticMatcherService.analyzeSchema(target),
    );

    const delivery = candidates.find(
      (c) =>
        c.sourceField.toLowerCase().includes("estimateddelivery") &&
        c.targetField.toLowerCase().includes("estimateddelivery"),
    );
    assert.ok(delivery);
    assert.ok(delivery.confidence >= 0.65);
  });

  it("shipTo always outranks billTo for /destination/* targets", async () => {
    const payload = await loadJson("tests/fixtures/shipto-billto-shipment.json");

    // Inline target with /destination/* and /origin/* so no canonical:// ref resolution needed
    const targetSchema = {
      type: "object",
      properties: {
        destination: {
          type: "object",
          description: "Ship-to destination address.",
          properties: {
            name: { type: "string", description: "Recipient name." },
            line1: { type: "string", description: "Primary street address line." },
            city: { type: "string", description: "City or locality name." },
            stateOrProvince: { type: "string", description: "State or province." },
            postalCode: { type: "string", description: "Postal or ZIP code." },
            countryCode: { type: "string", description: "ISO country code." },
          },
        },
        origin: {
          type: "object",
          description: "Ship-from origin address.",
          properties: {
            name: { type: "string" },
            line1: { type: "string" },
            city: { type: "string" },
            postalCode: { type: "string" },
            countryCode: { type: "string" },
          },
        },
      },
    };

    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(payload, "CarrierWithBillTo");
    const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, payload);
    const targetAnalysis = semanticMatcherService.analyzeSchema(targetSchema as Record<string, unknown>);

    const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);

    const destMappings = candidates.filter((c) => c.targetField.startsWith("/destination/"));
    const billToDestMappings = candidates.filter(
      (c) =>
        c.sourceField.toLowerCase().startsWith("/billto/") &&
        c.targetField.startsWith("/destination/"),
    );

    // No billTo source may populate /destination/*
    assert.equal(
      billToDestMappings.length,
      0,
      `billTo must not populate /destination/*: ${JSON.stringify(billToDestMappings)}`,
    );

    // Every /destination/* mapping must come from a /shipTo/* source
    for (const m of destMappings) {
      assert.ok(
        m.sourceField.toLowerCase().startsWith("/shipto/"),
        `Expected /destination/* sourceField to start with /shipTo/, got: ${m.sourceField} → ${m.targetField}`,
      );
    }

    // Every leaf shipTo/* source field must be mapped (not left unmapped)
    const shipToLeaves = sourceAnalysis.fields
      .filter((f) => f.kind !== "object" && f.path.toLowerCase().startsWith("/shipto/"))
      .map((f) => f.path);
    const mappedSources = new Set(candidates.map((c) => c.sourceField));
    for (const shipToPath of shipToLeaves) {
      assert.ok(
        mappedSources.has(shipToPath),
        `Expected /shipTo leaf field to be mapped: ${shipToPath}`,
      );
    }
  });

  it("shipFrom/country maps to /origin/countryCode and billTo is excluded from /destination/*", async () => {
    // Fixture: billTo first (worst-case insertion order), shipFrom uses plain "country" not "countryCode"
    const payload = await loadJson("tests/fixtures/shipto-billto-shipment.json");

    const targetSchema = {
      type: "object",
      properties: {
        origin: {
          type: "object",
          description: "Ship-from address.",
          properties: {
            name: { type: "string" },
            line1: { type: "string" },
            city: { type: "string" },
            stateOrProvince: { type: "string" },
            postalCode: { type: "string" },
            countryCode: { type: "string" },
          },
        },
        destination: {
          type: "object",
          description: "Ship-to address.",
          properties: {
            name: { type: "string" },
            line1: { type: "string" },
            city: { type: "string" },
            stateOrProvince: { type: "string" },
            postalCode: { type: "string" },
            countryCode: { type: "string" },
          },
        },
      },
    };

    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(payload, "CarrierBothBlocks");
    const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, payload);
    const targetAnalysis = semanticMatcherService.analyzeSchema(targetSchema as Record<string, unknown>);
    const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);

    // /shipFrom/country must reach /origin/countryCode
    const originCountryMapping = candidates.find((c) => c.targetField === "/origin/countryCode");
    assert.ok(
      originCountryMapping,
      `/origin/countryCode must be mapped, got unmapped. All mappings: ${JSON.stringify(candidates.map((c) => `${c.sourceField}→${c.targetField}`))}`,
    );
    assert.ok(
      originCountryMapping.sourceField.toLowerCase().startsWith("/shipfrom/"),
      `Expected /shipFrom/* → /origin/countryCode, got: ${originCountryMapping.sourceField}`,
    );

    // No billTo field maps to /destination/*
    const billToDestMappings = candidates.filter(
      (c) =>
        c.sourceField.toLowerCase().startsWith("/billto/") &&
        c.targetField.startsWith("/destination/"),
    );
    assert.equal(
      billToDestMappings.length,
      0,
      `billTo must not populate /destination/*: ${JSON.stringify(billToDestMappings)}`,
    );

    // Full pipeline: execute and verify targetPayload.origin.countryCode === "US"
    const plan = {
      mappings: candidates.map((c) => ({
        sourceField: c.sourceField,
        targetField: c.targetField,
        confidence: c.confidence,
        transformation: "direct",
        reasoning: c.reasoning ?? "",
      })),
      unmappedSourceFields: [],
      unmappedTargetFields: [],
    };
    const execution = await executor.executeWithOptions({
      sourcePayload: payload,
      plan,
      options: { minConfidence: 0.4 },
    });

    const target = execution.targetPayload as Record<string, unknown>;
    const origin = target.origin as Record<string, unknown> | undefined;
    assert.equal(
      origin?.countryCode,
      "US",
      `Expected targetPayload.origin.countryCode = "US", got: ${origin?.countryCode}`,
    );

    // Acceptance: no billTo in appliedMappings for /destination/*
    const billToInDest = execution.appliedMappings.filter(
      (m) =>
        m.sourceField.toLowerCase().startsWith("/billto/") &&
        m.targetField.startsWith("/destination/"),
    );
    assert.equal(billToInDest.length, 0, "No billTo mapping may reach /destination/* in appliedMappings");
  });

  it("scores consigneePostalCode to destination.postalCode with parent context", () => {
    const source = {
      path: "/recipient/address/postalCode",
      name: "postalCode",
      kind: "primitive" as const,
      types: ["string"],
      required: false,
      isExtension: false,
      metadata: {},
      parentPath: "/recipient/address",
      parentContext: "destination",
    };
    const target = {
      path: "/destination/postalCode",
      name: "postalCode",
      kind: "primitive" as const,
      types: ["string"],
      required: true,
      description: "Postal or ZIP code.",
      isExtension: false,
      metadata: {},
      parentPath: "/destination",
      parentContext: "destination",
    };

    const breakdown = computeSemanticSimilarity(source, target);
    assert.ok(breakdown.total >= 0.65, `expected high score, got ${breakdown.total}`);
    assert.ok(breakdown.reasons.some((r) => r.includes("parent_context") || r.includes("semantic_concept")));
  });
});
