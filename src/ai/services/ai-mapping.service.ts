import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadAiConfig } from "../config.js";
import type {
  FieldMapping,
  GenerateMappingRequest,
  GenerateMappingResponse,
  SuggestedMapping,
} from "../models/mapping.types.js";
import { aiLog } from "../utils/ai-logger.js";
import { inferDeliveryDateTransformation } from "../utils/date-normalize.js";
import { buildMappingReasoning, computeSemanticSimilarity } from "../utils/semantic-scoring.js";
import { promptBuilderService } from "./prompt-builder.service.js";
import { requiredFieldResolverService } from "./required-field-resolver.service.js";
import { semanticMatcherService } from "./semantic-matcher.service.js";
import type { CustomVocabularyStore } from "./custom-vocabulary.store.js";
import { vocabularyStore as defaultVocabularyStore } from "./custom-vocabulary.store.js";
import type { SchemaFieldDescriptor } from "../models/schema-field.types.js";

const log = aiLog("ai-mapping");

export class AiMappingService {
  private anthropic: Anthropic | null = null;
  private readonly mappingCache = new Map<string, FieldMapping[]>();

  constructor(
    private readonly config = loadAiConfig(),
    private readonly vocabStore: CustomVocabularyStore = defaultVocabularyStore,
  ) {
    if (this.config.anthropicApiKey) {
      this.anthropic = new Anthropic({ apiKey: this.config.anthropicApiKey });
    }
  }

  private buildCacheKey(sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>): string {
    const paths = sourceAnalysis.fields.map((f) => f.path).sort().join("|");
    return createHash("sha256").update(paths).digest("hex").slice(0, 16);
  }

  async generateMapping(request: GenerateMappingRequest): Promise<GenerateMappingResponse> {
    if (!this.config.mappingEnabled) {
      throw new AiMappingError("AI mapping is disabled", 503);
    }

    this.validateRequest(request);

    const sourceAnalysis = semanticMatcherService.analyzeSchema(
      request.sourceSchema,
      request.sourceExamplePayload,
      "source",
    );
    const targetAnalysis = semanticMatcherService.analyzeSchema(
      request.targetSchema,
      request.targetExamplePayload,
      "target",
    );

    log.info(
      {
        sourceFieldCount: sourceAnalysis.fields.length,
        targetFieldCount: targetAnalysis.fields.length,
        sourceSample: sourceAnalysis.fields.slice(0, 15).map((f) => f.path),
        targetSample: targetAnalysis.fields.slice(0, 15).map((f) => f.path),
      },
      "Discovered fields for mapping",
    );

    const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);
    let mappings = this.candidatesToMappings(candidates, sourceAnalysis, targetAnalysis);

    // ── Custom vocabulary injection (priority tier above heuristic) ───────────
    // Learned mappings come in at confidence 1.0 and displace any heuristic match
    // for the same source or target field. Fields covered here never reach AI.
    const clientId = request.options?.clientId;
    if (clientId) {
      const vocabMappings = await this.loadVocabularyMappings(
        clientId,
        sourceAnalysis.fields,
        targetAnalysis.fields,
      );
      if (vocabMappings.length > 0) {
        mappings = applyVocabularyMappings(mappings, vocabMappings);
        log.info(
          { clientId, count: vocabMappings.length },
          "Custom vocabulary mappings applied",
        );
      }
    }

    const heuristicAvg = averageConfidence(mappings);

    const mappedTargets = new Set(mappings.map((m) => m.targetField));
    const targetByPath = new Map(targetAnalysis.fields.map((f) => [f.path, f]));
    const unmappedRequiredBefore = targetAnalysis.fields
      .filter((f) => isTrulyUnmappedRequired(f, mappedTargets, targetByPath))
      .map((f) => f.path);

    const noMappingsFound = mappings.length === 0;
    const belowThreshold = heuristicAvg < this.config.aiFallbackThreshold;
    const hasUnmappedRequired = unmappedRequiredBefore.length > 0;

    const needsAi =
      this.config.aiFallbackEnabled &&
      this.anthropic &&
      (noMappingsFound || belowThreshold || hasUnmappedRequired);

    let generationMode: "heuristic" | "hybrid" | "ai" = needsAi ? "hybrid" : "heuristic";

    log.info(
      {
        candidateCount: candidates.length,
        heuristicMappingCount: mappings.length,
        heuristicAvg,
        noMappingsFound,
        belowThreshold,
        hasUnmappedRequired,
        unmappedRequired: unmappedRequiredBefore,
        aiFallbackEnabled: this.config.aiFallbackEnabled,
        hasAnthropicKey: Boolean(this.anthropic),
        needsAi,
      },
      "AI fallback decision",
    );

    if (needsAi) {
      log.info(
        {
          heuristicAvg,
          threshold: this.config.aiFallbackThreshold,
          unmappedRequired: unmappedRequiredBefore.length,
          reason: noMappingsFound
            ? "no_mappings_found"
            : belowThreshold
              ? "below_confidence_threshold"
              : "unmapped_required_fields",
        },
        "AI fallback triggered for semantic mapping",
      );

      const cacheKey = this.buildCacheKey(sourceAnalysis);
      const cachedMappings = this.mappingCache.get(cacheKey);
      let aiMappings: FieldMapping[];
      if (cachedMappings) {
        log.info({ cacheKey }, "AI mappings cache hit — skipping Anthropic call");
        aiMappings = cachedMappings;
      } else {
        aiMappings = await this.invokeAiMappings(
          request,
          sourceAnalysis,
          targetAnalysis,
          candidates,
        );
        this.mappingCache.set(cacheKey, aiMappings);
      }
      mappings = mergeMappings(mappings, aiMappings);
      // Role-context guard must run BEFORE deduplication: remove cross-context AI mappings
      // before they can displace the correct heuristic mappings via deduplicateBySource.
      mappings = filterCrossContextMappings(mappings);
      mappings = deduplicateBySource(mappings);
      generationMode = "hybrid";

      const mappedAfterFirst = new Set(mappings.map((m) => m.targetField));
      const stillMissing = REQUIRED_TARGET_PATHS.filter((p) => !mappedAfterFirst.has(p));
      if (stillMissing.length > 0) {
        log.info({ stillMissing }, "Second AI pass for missing required fields");
        const focusedTargetAnalysis = {
          ...targetAnalysis,
          fields: targetAnalysis.fields.filter((f) => stillMissing.includes(f.path)),
        };
        const secondAiMappings = await this.invokeAiMappings(
          request,
          sourceAnalysis,
          focusedTargetAnalysis,
          candidates,
        );
        mappings = mergeMappings(mappings, secondAiMappings);
        mappings = filterCrossContextMappings(mappings);
        mappings = deduplicateBySource(mappings);
      }
    } else if (!this.anthropic && (noMappingsFound || belowThreshold)) {
      log.warn(
        {
          noMappingsFound,
          belowThreshold,
          heuristicAvg,
        },
        "ANTHROPIC_API_KEY not set; cannot run AI fallback",
      );
    }

    const resolved = requiredFieldResolverService.resolve(
      sourceAnalysis,
      targetAnalysis,
      mappings,
      { defaults: request.options?.defaults },
    );

    mappings = resolved.augmentedMappings;
    mappings = filterCrossContextMappings(mappings); // catch resolver-injected cross-context fills
    mappings = deduplicateBySource(mappings);
    mappings = filterBlacklistedTargets(mappings);

    // Synthesize mappings for reference-only origin indicators (e.g. warehouseId → extensions.originRef)
    // that have no heuristic or AI candidate because their target (/extensions) is a dynamic bucket.
    mappings = synthesizeReferenceExtensions(mappings, sourceAnalysis, targetAnalysis);

    // Carrier parcel conventions: some source fields (e.g. EasyPost's /parcel/weight,
    // /parcel/height, /parcel/length, /parcel/width) are implicitly in a fixed unit with
    // no unit sibling in the source schema. Inject a companion constant unit mapping for
    // any such target that isn't already mapped. See PARCEL_UNIT_CONVENTIONS below.
    mappings = injectParcelUnitDefaults(mappings);

    // Partition by autoApplyThreshold: candidates strictly below go to review, not auto-apply
    const { autoApplyThreshold } = this.config;
    const lowConfidenceMappings = mappings.filter((m) => m.confidence < autoApplyThreshold);
    mappings = mappings.filter((m) => m.confidence >= autoApplyThreshold);

    const mappedSources = new Set(mappings.map((m) => m.sourceField));
    const mappedTargetsFinal = new Set(mappings.map((m) => m.targetField));

    const unmappedSourceFields = semanticMatcherService.findUnmapped(sourceAnalysis, mappedSources);

    const response: GenerateMappingResponse = {
      mappings,
      lowConfidenceMappings,
      unmappedSourceFields,
      unmappedTargetFields: semanticMatcherService.findUnmapped(targetAnalysis, mappedTargetsFinal),
      requiredFieldSuggestions: resolved.suggestions,
      suggestedMappings: buildSuggestedMappings(unmappedSourceFields, targetAnalysis.fields),
      metadata: {
        generationMode,
        provider: needsAi ? "anthropic" : "heuristic",
        model: needsAi ? this.config.anthropicModel : undefined,
        sourceSchemaId: sourceAnalysis.schemaId,
        targetSchemaId: targetAnalysis.schemaId,
        averageConfidence: Math.round(averageConfidence(mappings) * 100) / 100,
        heuristicConfidence: Math.round(heuristicAvg * 100) / 100,
        aiEnhanced: Boolean(needsAi),
        transformationPlanVersion: "2.0.0",
      },
    };

    log.info(
      {
        mappingCount: response.mappings.length,
        averageConfidence: response.metadata?.averageConfidence,
        aiEnhanced: response.metadata?.aiEnhanced,
      },
      "Mapping plan generated",
    );

    return response;
  }

  private candidatesToMappings(
    candidates: ReturnType<typeof semanticMatcherService.findCandidateMappings>,
    sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
    targetAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
  ): FieldMapping[] {
    return candidates.map((c) => {
      const sf = sourceAnalysis.fields.find((f) => f.path === c.sourceField);
      const tf = targetAnalysis.fields.find((f) => f.path === c.targetField);
      const reasoning =
        c.reasoning ??
        (sf && tf
          ? buildMappingReasoning(sf, tf, computeSemanticSimilarity(sf, tf))
          : `Semantic match: ${c.matchReasons.join(", ")}`);

      return {
        sourceField: c.sourceField,
        targetField: c.targetField,
        confidence: c.confidence,
        transformation: inferTransformation(c.sourceField, c.targetField),
        reasoning,
      };
    });
  }

  private async invokeAiMappings(
    request: GenerateMappingRequest,
    sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
    targetAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
    candidates: ReturnType<typeof semanticMatcherService.findCandidateMappings>,
  ): Promise<FieldMapping[]> {
    const { systemPrompt, userPrompt } = await promptBuilderService.buildMappingPrompt({
      sourceAnalysis,
      targetAnalysis,
      candidates,
      sourceExamplePayload: request.sourceExamplePayload,
      targetExamplePayload: request.targetExamplePayload,
    });

    const message = await this.anthropic!.messages.create({
      model: this.config.anthropicModel,
      max_tokens: this.config.anthropicMaxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const completionText = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    log.info({ responseLength: completionText.length }, "Anthropic fallback mapping response received");

    const parsed = this.parseAiResponse(completionText);
    if (!parsed?.mappings) {
      return [];
    }

    const validTargetPaths = new Set(targetAnalysis.fields.map((f) => f.path));

    return parsed.mappings
      .filter((m) => m.sourceField && m.targetField)
      .filter((m) => validTargetPaths.has(m.targetField))
      .map((m) => ({
        sourceField: m.sourceField,
        targetField: m.targetField,
        confidence: clampConfidence(m.confidence ?? 0.75),
        transformation: m.transformation || "direct",
        reasoning: m.reasoning || "AI-proposed semantic mapping for fields without strong heuristic match.",
      }));
  }

  private validateRequest(request: GenerateMappingRequest): void {
    if (!request.sourceSchema || typeof request.sourceSchema !== "object") {
      throw new AiMappingError("sourceSchema is required and must be an object", 400);
    }
    if (!request.targetSchema || typeof request.targetSchema !== "object") {
      throw new AiMappingError("targetSchema is required and must be an object", 400);
    }
  }

  private parseAiResponse(text: string): Partial<GenerateMappingResponse> | null {
    const jsonText = extractJsonFromText(text);
    try {
      const json = JSON.parse(jsonText) as Partial<GenerateMappingResponse>;
      if (!Array.isArray(json.mappings)) {
        return null;
      }
      return json;
    } catch {
      return null;
    }
  }

  // ── Vocabulary helpers ──────────────────────────────────────────────────────

  /** Load this client's vocabulary and translate it into FieldMapping objects. */
  private async loadVocabularyMappings(
    clientId: string,
    sourceFields: SchemaFieldDescriptor[],
    targetFields: SchemaFieldDescriptor[],
  ): Promise<FieldMapping[]> {
    const vocab = await this.vocabStore.load(clientId);
    if (vocab.size === 0) return [];

    const validTargetPaths = new Set(targetFields.map((f) => f.path));
    const mappings: FieldMapping[] = [];

    for (const sf of sourceFields) {
      if (sf.kind === "object") continue;
      const hit = vocab.get(sf.path) ?? vocab.get(sf.name);
      if (!hit || !validTargetPaths.has(hit)) continue;
      mappings.push({
        sourceField: sf.path,
        targetField: hit,
        confidence: CUSTOM_VOCAB_CONFIDENCE,
        transformation: inferTransformation(sf.path, hit),
        reasoning: `Custom vocabulary: '${sf.name}' was explicitly mapped to '${hit}' for this client.`,
      });
    }

    return mappings;
  }
}

const REQUIRED_TARGET_PATHS = [
  "/origin/line1",
  "/origin/city",
  "/origin/countryCode",
  "/destination/line1",
  "/destination/city",
  "/destination/countryCode",
  "/packages",
];

function mergeMappings(heuristic: FieldMapping[], ai: FieldMapping[]): FieldMapping[] {
  const byTarget = new Map<string, FieldMapping>();
  for (const m of heuristic) {
    byTarget.set(m.targetField, m);
  }
  for (const m of ai) {
    const existing = byTarget.get(m.targetField);
    if (!existing || m.confidence > existing.confidence) {
      byTarget.set(m.targetField, {
        ...m,
        reasoning: m.reasoning || existing?.reasoning || "AI-enhanced mapping.",
        confidence: clampConfidence(m.confidence),
      });
    }
  }
  return [...byTarget.values()].sort((a, b) => a.targetField.localeCompare(b.targetField));
}

const BLACKLISTED_TARGET_PATHS = new Set([
  "/metadata/tags[]/value",
  "/customs/lineItems[]/weight/value",
  "/customs/lineItems[]/weight/unit",
  "/trackingReferences[]/value",
]);

function filterBlacklistedTargets(mappings: FieldMapping[]): FieldMapping[] {
  return mappings.filter((m) => {
    if (!BLACKLISTED_TARGET_PATHS.has(m.targetField)) {
      return true;
    }
    const srcLower = m.sourceField.toLowerCase();
    return srcLower.includes("custom") || srcLower.includes("trackingreference");
  });
}

function deduplicateBySource(mappings: FieldMapping[]): FieldMapping[] {
  const bySource = new Map<string, FieldMapping>();
  for (const m of mappings) {
    const existing = bySource.get(m.sourceField);
    if (!existing || m.confidence > existing.confidence) {
      bySource.set(m.sourceField, m);
    }
  }
  return [...bySource.values()].sort((a, b) => a.targetField.localeCompare(b.targetField));
}

function averageConfidence(mappings: FieldMapping[]): number {
  if (mappings.length === 0) {
    return 0;
  }
  return mappings.reduce((s, m) => s + m.confidence, 0) / mappings.length;
}

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function inferTransformation(sourceField: string, targetField: string): string {
  // extensions:passthrough is for routing to the /extensions bucket generically.
  // A specific named sub-path (/extensions/someKey) should set the scalar value directly.
  if (targetField === "/extensions" || sourceField.includes("extensions")) {
    return "extensions:passthrough";
  }
  if (targetField.startsWith("/extensions/")) {
    return "cast:string";
  }
  if (sourceField.includes("countryCode") || targetField.includes("countryCode")) {
    return "direct|normalize:countryCode";
  }
  const deliveryTransform = inferDeliveryDateTransformation(sourceField, targetField);
  if (deliveryTransform) {
    return deliveryTransform;
  }
  if (targetField.endsWith("/weight/unit")) {
    // Weight-unit targets need synonym expansion (pounds → lb, kilograms → kg, etc.)
    return "cast:string|normalize:weightUnit";
  }
  if (targetField.endsWith("/dimensions/unit")) {
    // Dimension-unit targets need synonym expansion (inches → in, centimeters → cm, etc.)
    return "cast:string|normalize:dimensionUnit";
  }
  if (targetField.endsWith("/unit")) {
    if (sourceField.includes("[]") && targetField.includes("[]")) {
      return "array:map|cast:string|normalize:lowercase";
    }
    return "cast:string|normalize:lowercase";
  }
  if (sourceField.includes("[]") && targetField.startsWith("/identifiers/")) {
    // Identifier fields from array sources may be numeric; coerce to string
    return "array:first|toString";
  }
  if (sourceField.includes("[]") && !targetField.includes("[]")) {
    return "array:first|direct";
  }
  if (sourceField.includes("[]") && targetField.includes("[]")) {
    return "array:map";
  }
  return "direct";
}

// ─── Role-context guard ──────────────────────────────────────────────────────
// Destination-context sources (shipTo, billTo, recipient …) must NEVER map to
// /origin/* targets, and origin-context sources (shipFrom, shipper …) must
// NEVER map to /destination/* targets.  This invariant is enforced in the
// heuristic layer; here we extend it to AI-generated and resolver-augmented
// mappings so the AI cannot silently fabricate an origin address from the
// recipient's fields.

const DEST_SRC_RE = /^\/(?:shipto|billto|recipient|consignee|deliveryaddress|buyer|customer)\//i;
const ORIGIN_SRC_RE = /^\/(?:shipfrom|shipper|sender|origin)\//i;

function filterCrossContextMappings(mappings: FieldMapping[]): FieldMapping[] {
  return mappings.filter((m) => {
    const src = m.sourceField;
    const tgt = m.targetField;
    if (DEST_SRC_RE.test(src) && tgt.startsWith("/origin/")) {
      log.warn(
        { sourceField: src, targetField: tgt, confidence: m.confidence },
        "Cross-context mapping rejected: destination-context source → /origin/* target",
      );
      return false;
    }
    if (ORIGIN_SRC_RE.test(src) && tgt.startsWith("/destination/")) {
      log.warn(
        { sourceField: src, targetField: tgt, confidence: m.confidence },
        "Cross-context mapping rejected: origin-context source → /destination/* target",
      );
      return false;
    }
    return true;
  });
}

// ─── Reference-extension synthesizer ─────────────────────────────────────────
// When a source field is a reference-style origin identifier (e.g. ShipStation's
// advancedOptions.warehouseId), it cannot be matched via the normal candidate
// pipeline because the destination key (/extensions/originRef) is a dynamic
// additionalProperties path not present in the target field analysis.
// This synthesizer adds the mapping directly after all other processing, so
// the warehouseId ends up in extensions rather than unmappedSourceFields.

const ORIGIN_REF_PATTERNS: Array<{
  pattern: RegExp;
  extensionKey: string;
  reasoning: string;
}> = [
  {
    pattern: /^\/(?:advancedOptions|options|settings)\/warehouseId$/i,
    extensionKey: "originRef",
    reasoning:
      "advancedOptions.warehouseId is a ShipStation origin-warehouse reference; " +
      "stored as extensions.originRef for downstream resolution into a full address.",
  },
];

function synthesizeReferenceExtensions(
  mappings: FieldMapping[],
  sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
  targetAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
): FieldMapping[] {
  const hasExtensions = targetAnalysis.fields.some((f) => f.path === "/extensions");
  if (!hasExtensions) return mappings;

  const mappedSources = new Set(mappings.map((m) => m.sourceField));
  const added: FieldMapping[] = [];

  for (const sf of sourceAnalysis.fields) {
    if (mappedSources.has(sf.path) || sf.kind === "object") continue;
    for (const ref of ORIGIN_REF_PATTERNS) {
      if (ref.pattern.test(sf.path)) {
        added.push({
          sourceField: sf.path,
          targetField: "/extensions",
          confidence: 0.87,
          transformation: `cast:string|wrap:${ref.extensionKey}`,
          reasoning: ref.reasoning,
        });
        mappedSources.add(sf.path);
        break;
      }
    }
  }

  if (added.length > 0) {
    log.info(
      { synthesized: added.map((m) => `${m.sourceField} → ${m.targetField}`) },
      "Reference-extension mappings synthesized",
    );
  }

  return [...mappings, ...added];
}

/**
 * A carrier's source schema sometimes fixes a field to one unit with no unit
 * sibling present anywhere in the source (e.g. EasyPost's /parcel/weight is
 * always ounces). `targetSuffix` matches the value target(s) this applies to;
 * `unitSuffix` is substituted in to derive the companion unit target. Several
 * value targets may share one unit target (EasyPost's dimensions/height,
 * /length, /width all resolve to the single dimensions/unit field) — the
 * injector below dedupes so each unit target is only injected once.
 */
interface ParcelUnitConvention {
  sourcePattern: RegExp;
  targetSuffix: RegExp;
  unitSuffix: string;
  unit: string;
  reasoning: string;
}

const PARCEL_UNIT_CONVENTIONS: ParcelUnitConvention[] = [
  {
    sourcePattern: /\/parcel\/weight$/,
    targetSuffix: /\/weight\/value$/,
    unitSuffix: "/weight/unit",
    unit: "oz",
    reasoning:
      "EasyPost parcel convention: /parcel/weight is always in ounces; no unit field is present in the source",
  },
  {
    sourcePattern: /\/parcel\/(height|length|width)$/,
    targetSuffix: /\/dimensions\/(height|length|width)$/,
    unitSuffix: "/dimensions/unit",
    unit: "in",
    reasoning:
      "EasyPost parcel convention: /parcel/height, /parcel/length, and /parcel/width are always in inches; no unit field is present in the source",
  },
];

function injectParcelUnitDefaults(mappings: FieldMapping[]): FieldMapping[] {
  const mappedTargets = new Set(mappings.map((m) => m.targetField));
  const companions: FieldMapping[] = [];

  for (const convention of PARCEL_UNIT_CONVENTIONS) {
    const valueMappings = mappings.filter(
      (m) => convention.sourcePattern.test(m.sourceField) && convention.targetSuffix.test(m.targetField),
    );

    for (const m of valueMappings) {
      const unitTarget = m.targetField.replace(convention.targetSuffix, convention.unitSuffix);
      if (mappedTargets.has(unitTarget)) continue;

      companions.push({
        sourceField: m.sourceField,
        targetField: unitTarget,
        confidence: 1.0,
        transformation: `constant:"${convention.unit}"`,
        reasoning: convention.reasoning,
      });
      mappedTargets.add(unitTarget);
    }
  }

  if (companions.length > 0) {
    log.info(
      { injected: companions.map((c) => c.targetField) },
      "Injected carrier parcel unit defaults",
    );
  }

  return companions.length > 0 ? [...mappings, ...companions] : mappings;
}

// ── Required-field gate (hasUnmappedRequired) ────────────────────────────────
//
// A required field counts against the AI-fallback gate ONLY when every ancestor
// in the canonical target schema is also required.  Without this, optional parent
// fields (customs, weight, metadata, trackingReferences) whose nested children are
// marked required-within-their-parent would fire the gate for virtually every
// payload — triggering an AI call even when the payload is legitimately complete.
//
// Ancestor-chain rule:
//   /origin/line1            → /origin (required) → root           → counts ✓
//   /packages[]/weight/value → /packages[]/weight (required)
//                            → /packages (required, array)         → counts ✓
//   /packages[]/declaredValue/amount → /packages[]/declaredValue (required=false)
//                                                                   → skipped ✗
//   /customs/lineItems[]/description → /customs (required=false)   → skipped ✗
//
// Array-parent rule: a required array field (e.g. /packages) is considered
// covered when any of its child paths are already in mappedTargets — the executor
// creates the array as a side-effect of mapping child fields.

function isTrulyUnmappedRequired(
  field: SchemaFieldDescriptor,
  mappedTargets: Set<string>,
  byPath: Map<string, SchemaFieldDescriptor>,
): boolean {
  if (field.kind === "object") return false;
  if (mappedTargets.has(field.path)) return false;

  // Array parent: covered implicitly when child paths are mapped
  if (field.kind === "array") {
    const childPrefix = field.path.replace(/\[\]$/, "") + "[]/";
    if ([...mappedTargets].some((t) => t.startsWith(childPrefix))) return false;
  }

  return isAncestorChainRequired(field.path, byPath);
}

/**
 * Walk the parentPath chain. Returns false as soon as any ancestor is not
 * required (meaning it is an optional parent — its children shouldn't gate AI).
 * Array-item paths like /packages[] are not emitted by analyzeSchema; strip []
 * to find the corresponding array field.
 */
function isAncestorChainRequired(
  startPath: string,
  byPath: Map<string, SchemaFieldDescriptor>,
): boolean {
  let current: string = startPath;

  while (current) {
    const field = byPath.get(current);
    if (field) {
      if (!field.required) return false;
      const parent = field.parentPath;
      if (!parent || parent === "ROOT") return true; // reached root, all required
      current = parent;
    } else {
      // Array-item placeholder (e.g. /packages[]) — not emitted by analyzeSchema.
      // Strip the [] suffix and check the array field itself.
      const stripped = current.replace(/\[\]$/, "");
      if (stripped === current) return true; // nothing to strip, stop
      current = stripped;
    }
  }

  return true;
}

// ── Custom vocabulary confidence ──────────────────────────────────────────────
export const CUSTOM_VOCAB_CONFIDENCE = 1.0;

/**
 * Merge vocabulary mappings (confidence 1.0) into the heuristic set.
 * Vocabulary wins on both source and target conflicts — the whole point is that
 * a learned mapping never loses to a heuristic guess.
 */
function applyVocabularyMappings(
  heuristic: FieldMapping[],
  vocab: FieldMapping[],
): FieldMapping[] {
  if (vocab.length === 0) return heuristic;
  const vocabSources = new Set(vocab.map((m) => m.sourceField));
  const vocabTargets = new Set(vocab.map((m) => m.targetField));
  const filtered = heuristic.filter(
    (m) => !vocabSources.has(m.sourceField) && !vocabTargets.has(m.targetField),
  );
  return [...vocab, ...filtered];
}

// ── suggestedMappings builder ─────────────────────────────────────────────────

/**
 * For each unmapped source path, find the closest canonical target leaf by
 * Dice-coefficient similarity on the normalised field name. Returns a
 * suggestion even when confidence is low so opaque codes (NTGEW, LFIMG …)
 * surface with an honest near-zero score and "needs explicit mapping" reason.
 */
function buildSuggestedMappings(
  unmappedSourcePaths: string[],
  targetFields: SchemaFieldDescriptor[],
): SuggestedMapping[] {
  const leafTargets = targetFields.filter((f) => f.kind !== "object");
  if (leafTargets.length === 0 || unmappedSourcePaths.length === 0) return [];

  return unmappedSourcePaths.flatMap((sourcePath): SuggestedMapping[] => {
    const srcLeaf = normForSuggestion(
      sourcePath.split("/").filter(Boolean).pop() ?? "",
    );
    if (!srcLeaf) return [];

    let best: { path: string; score: number } | null = null;
    for (const tf of leafTargets) {
      const tgtLeaf = normForSuggestion(
        tf.path.split("/").filter(Boolean).pop() ?? "",
      );
      const score = diceCoefficient(srcLeaf, tgtLeaf);
      if (!best || score > best.score) best = { path: tf.path, score };
    }
    if (!best) return [];

    const confidence = Number(best.score.toFixed(2));
    return [
      {
        inputField: sourcePath,
        suggestedCanonical: best.path,
        confidence,
        reason:
          confidence >= 0.4
            ? `Closest canonical field by name similarity (${Math.round(confidence * 100)}%).`
            : `Opaque field name — no close canonical match (${Math.round(confidence * 100)}%); needs explicit /vocabulary/accept mapping.`,
      },
    ];
  });
}

function normForSuggestion(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of aB) {
    overlap += Math.min(count, bB.get(bg) ?? 0);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

export class AiMappingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AiMappingError";
  }
}

export const aiMappingService = new AiMappingService();
