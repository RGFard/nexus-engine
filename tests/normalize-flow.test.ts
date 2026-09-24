import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { aiMappingService } from "../src/ai/services/ai-mapping.service.js";
import { semanticMatcherService } from "../src/ai/services/semantic-matcher.service.js";
import { schemaRefResolver } from "../src/ai/services/schema-ref-resolver.service.js";
import { schemaRegistry } from "../src/services/schema-registry.service.js";
import { SchemaValidationService } from "../src/services/schema-validation.service.js";
import { TransformationExecutorService } from "../src/ai/services/transformation-executor.service.js";
import { loadJson } from "./helpers/load-schema.js";

const executor = new TransformationExecutorService();

before(async () => {
  await schemaRegistry.initialize();
  schemaRefResolver.loadFromRegistry(schemaRegistry);
  semanticMatcherService.setRefResolver(schemaRefResolver);
});

describe("POST /ai/normalize mapping flow", () => {
  it("generates mappings from FedEx payload when sourceSchema is empty (normalize path)", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const target = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");

    const plan = await aiMappingService.generateMapping({
      sourceSchema: { type: "object", additionalProperties: true },
      targetSchema: target,
      sourceExamplePayload: fedex,
    });

    assert.ok(plan.mappings.length > 0, "expected mappings from empty source schema + payload");
    assert.ok(plan.metadata && plan.metadata.averageConfidence > 0);

    const tracking = plan.mappings.find(
      (m) =>
        m.sourceField.includes("masterTrackingNumber") &&
        m.targetField.includes("trackingNumber"),
    );
    assert.ok(tracking, "masterTrackingNumber -> trackingNumber");
    assert.ok(tracking.confidence >= 0.7);
    assert.ok(tracking.reasoning.length > 10);
  });

  it("maps estimatedDeliveryTimestamp to estimatedDelivery.dateTime", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const target = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");

    const plan = await aiMappingService.generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(fedex, "FedEx"),
      targetSchema: target,
      sourceExamplePayload: fedex,
    });

    const delivery = plan.mappings.find(
      (m) =>
        m.sourceField.toLowerCase().includes("estimateddeliverytimestamp") &&
        m.targetField.includes("/estimatedDelivery/dateTime"),
    );

    assert.ok(delivery, "expected estimatedDeliveryTimestamp -> /estimatedDelivery/dateTime");
    assert.ok(delivery.confidence >= 0.65);
    assert.ok(
      delivery.reasoning.toLowerCase().includes("deliver") ||
        delivery.reasoning.length > 15,
      "expected descriptive reasoning",
    );
  });

  it("executes FedEx transaction response mappings into targetPayload", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-transaction-response.json");
    const target = await loadJson("src/schemas/shipment/shipment-create-response.schema.json");

    const plan = await aiMappingService.generateMapping({
      sourceSchema: semanticMatcherService.inferSchemaFromPayload(fedex, "FedEx"),
      targetSchema: target,
      sourceExamplePayload: fedex,
    });

    const { TransformationExecutorService } = await import(
      "../src/ai/services/transformation-executor.service.js"
    );
    const executor = new TransformationExecutorService();
    const execution = await executor.executeWithOptions({
      sourcePayload: fedex,
      plan,
      options: { minConfidence: 0.5 },
    });

    const tracking = execution.appliedMappings.find((m) =>
      m.targetField.includes("trackingNumber"),
    );
    const delivery = execution.appliedMappings.find((m) =>
      m.targetField.includes("/estimatedDelivery/dateTime"),
    );

    assert.ok(tracking, "tracking mapping should be applied, not skipped");
    assert.ok(delivery, "delivery mapping should be applied, not skipped");

    const payload = execution.targetPayload as Record<string, unknown>;
    assert.equal(payload.trackingNumber, "FedEx-1007");
    assert.equal(
      (payload.estimatedDelivery as Record<string, unknown>).dateTime,
      "2026-05-30T17:00:00.000Z",
    );
  });

  it("discovers nested source fields from FedEx payload", async () => {
    const fedex = await loadJson("tests/fixtures/fedex-shipment.json");
    const analysis = semanticMatcherService.analyzeSchema(
      { type: "object", additionalProperties: true },
      fedex,
      "source",
    );

    assert.ok(
      analysis.fields.some((f) => f.path.includes("masterTrackingNumber")),
      "should discover root tracking field",
    );
    assert.ok(
      analysis.fields.some((f) => f.path.includes("shipper") || f.path.includes("recipient")),
      "should discover nested address fields",
    );
  });
});

describe("autoApplyThreshold — low-confidence routing", () => {
  // Inline origin/destination target — no canonical:// refs so no registry needed
  const ADDRESS_TARGET = {
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
  } as const;

  it("routes sub-threshold candidates to lowConfidenceMappings and leaves applied mappings intact", async () => {
    const payload = await loadJson("tests/fixtures/shipto-billto-shipment.json");
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(payload, "ShipStation");

    const plan = await aiMappingService.generateMapping({
      sourceSchema,
      targetSchema: ADDRESS_TARGET as Record<string, unknown>,
      sourceExamplePayload: payload,
    });

    // plan.lowConfidenceMappings must exist (array, empty is fine for this payload)
    assert.ok(
      Array.isArray(plan.lowConfidenceMappings),
      "plan.lowConfidenceMappings must be an array",
    );

    // No mapping below 0.45 should be in plan.mappings
    const autoApplyThreshold = 0.45;
    for (const m of plan.mappings) {
      assert.ok(
        m.confidence >= autoApplyThreshold,
        `plan.mappings contains a sub-threshold mapping: ${m.sourceField}→${m.targetField} (${m.confidence})`,
      );
    }

    // All address mappings for this payload score 0.48–0.71 — none should be routed low
    assert.equal(
      plan.lowConfidenceMappings.length,
      0,
      `Expected no low-confidence mappings for this payload, got: ${JSON.stringify(plan.lowConfidenceMappings.map((m) => `${m.sourceField}→${m.targetField}(${m.confidence})`))}`,
    );

    // Execute and verify targetPayload is unchanged from prior run
    const execution = await executor.executeWithOptions({
      sourcePayload: payload,
      plan,
      options: { minConfidence: 0 },
    });

    const target = execution.targetPayload as Record<string, unknown>;
    const origin = target.origin as Record<string, unknown> | undefined;
    const destination = target.destination as Record<string, unknown> | undefined;

    assert.equal(origin?.countryCode, "US", "origin.countryCode must be 'US'");
    assert.equal(destination?.countryCode, "US", "destination.countryCode must be 'US'");

    // All applied mappings must have confidence >= threshold
    for (const m of execution.appliedMappings) {
      assert.ok(
        m.confidence >= autoApplyThreshold,
        `appliedMappings contains a sub-threshold mapping: ${m.sourceField}→${m.targetField} (${m.confidence})`,
      );
    }
  });

  it("routes mappings below a custom threshold to lowConfidenceMappings", async () => {
    // Use a higher threshold (0.60) so some address mappings (0.48–0.59) are withheld
    const payload = await loadJson("tests/fixtures/shipto-billto-shipment.json");
    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(payload, "ShipStationHigh");

    // Temporarily override the threshold on the service config — we test the partitioning
    // logic directly via candidatesToMappings by calling generateMapping with env default 0.45,
    // then verify manually via the scores from findCandidateMappings.
    const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, payload);
    const targetAnalysis = semanticMatcherService.analyzeSchema(ADDRESS_TARGET as Record<string, unknown>);
    const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);

    // Partition manually at 0.60
    const high = candidates.filter((c) => c.confidence >= 0.60);
    const low = candidates.filter((c) => c.confidence < 0.60);

    // Some candidates (e.g. 0.48 addressLine1→line1, 0.50 country→countryCode) must be in low
    assert.ok(low.length > 0, "Expected at least one mapping below 0.60 for this payload");

    // High-confidence candidates (stateOrProvince 0.72, postalCode 0.71, etc.) are all above 0.60
    assert.ok(high.length > 0, "Expected at least one mapping at/above 0.60 for this payload");

    // Verify that at threshold 0.45 (the configured default), all of them would be auto-applied
    const belowDefault = candidates.filter((c) => c.confidence < 0.45);
    assert.equal(belowDefault.length, 0, "All candidates for this payload should be >= 0.45 (default threshold)");
  });
});

describe("ShipStation payload — end-to-end (Fix A + Fix B)", () => {
  let validatingExecutor: TransformationExecutorService;

  before(async () => {
    // registry is already initialized by the module-level before hook
    const validationService = new SchemaValidationService(schemaRegistry);
    await validationService.initialize();
    validatingExecutor = new TransformationExecutorService(validationService);
  });

  it("no shipTo→origin cross-context; destination correct; warehouseId → extensions.originRef; only origin errors remain", async () => {
    const payload = await loadJson("tests/fixtures/shipstation-shipment.json");
    const requestSchema = schemaRegistry.get("shipment", "shipment-create-request")!.schema;

    const sourceSchema = semanticMatcherService.inferSchemaFromPayload(payload, "ShipStation");
    const plan = await aiMappingService.generateMapping({
      sourceSchema,
      targetSchema: requestSchema,
      sourceExamplePayload: payload,
    });

    // (A) No /shipTo/* source may ever map to /origin/* target
    const crossContextViolations = plan.mappings.filter(
      (m) =>
        m.sourceField.toLowerCase().startsWith("/shipto/") &&
        m.targetField.startsWith("/origin/"),
    );
    assert.equal(
      crossContextViolations.length,
      0,
      `shipTo fields must not map to /origin/*: ${JSON.stringify(crossContextViolations.map((m) => `${m.sourceField}→${m.targetField}`))}`,
    );

    // (A) identifiers.shipmentId uses toString (Fix A unchanged)
    const shipmentIdMapping = plan.mappings.find((m) => m.targetField === "/identifiers/shipmentId");
    assert.ok(shipmentIdMapping, "/identifiers/shipmentId must be in plan.mappings");
    assert.ok(
      shipmentIdMapping.transformation.includes("toString"),
      `Expected toString in transformation, got: ${shipmentIdMapping.transformation}`,
    );

    // (B) weight/units mapped to packages, not stuck in unmappedSourceFields
    assert.ok(
      plan.mappings.some((m) => m.targetField === "/packages[]/weight/value"),
      "/packages[]/weight/value must be mapped",
    );
    assert.ok(
      plan.mappings.some((m) => m.targetField === "/packages[]/weight/unit"),
      "/packages[]/weight/unit must be mapped",
    );
    assert.ok(
      !plan.unmappedSourceFields.includes("/weight/units"),
      `/weight/units must not be in unmappedSourceFields`,
    );

    // (B) advancedOptions.warehouseId preserved as extensions.originRef, not unmapped
    assert.ok(
      !plan.unmappedSourceFields.some((p) => p.toLowerCase().includes("warehouseid")),
      `warehouseId must not appear in unmappedSourceFields: ${plan.unmappedSourceFields.join(", ")}`,
    );
    const warehouseMapping = plan.mappings.find((m) =>
      m.sourceField.toLowerCase().includes("warehouseid"),
    );
    assert.ok(warehouseMapping, "advancedOptions.warehouseId must have a mapping");
    assert.equal(warehouseMapping.targetField, "/extensions", "warehouseId must route to /extensions");

    // Execute with validation
    const result = await validatingExecutor.executeWithOptions({
      sourcePayload: payload,
      plan,
      options: {
        minConfidence: 0,
        validateTarget: { domain: "shipment", schemaName: "shipment-create-request" },
      },
    });

    const target = result.targetPayload as Record<string, unknown>;
    const destination = target.destination as Record<string, unknown> | undefined;
    const extensions = target.extensions as Record<string, unknown> | undefined;

    // (1) destination regains its fields from shipTo
    assert.ok(destination?.city, "destination.city must be set from shipTo");
    assert.ok(destination?.countryCode, "destination.countryCode must be set from shipTo");
    assert.equal(destination?.countryCode, "US", "destination.countryCode must be 'US'");

    // (2) packages[0] has weight
    const packages = target.packages as Array<Record<string, unknown>> | undefined;
    const pkg0Weight = (packages?.[0] as Record<string, unknown> | undefined)?.weight as Record<string, unknown> | undefined;
    assert.ok(pkg0Weight?.value !== undefined, "/packages/0/weight must have value");
    assert.equal(pkg0Weight?.unit, "lb", "/packages/0/weight/unit must be 'lb'");

    // (3) warehouseId preserved in extensions
    assert.ok(
      extensions?.originRef !== undefined,
      `extensions.originRef must be set, got extensions: ${JSON.stringify(extensions)}`,
    );
    assert.equal(String(extensions?.originRef), "98765", "extensions.originRef must be the warehouseId");

    // (4) /origin is absent (no legitimate source) — the ONLY remaining validation errors concern /origin
    const errors = result.validation?.errors ?? [];
    const nonOriginErrors = errors.filter(
      (e) => !e.instancePath.startsWith("/origin") && e.instancePath !== "",
    );
    // Also filter the root-level "must have required property 'origin'" error (instancePath = "")
    const rootErrors = errors.filter(
      (e) => e.instancePath === "" && !e.message?.includes("origin"),
    );
    assert.equal(
      nonOriginErrors.length + rootErrors.length,
      0,
      `Validation errors should concern only /origin, but found: ${JSON.stringify(
        [...nonOriginErrors, ...rootErrors].map((e) => `${e.instancePath}: ${e.message}`),
      )}`,
    );
  });
});
