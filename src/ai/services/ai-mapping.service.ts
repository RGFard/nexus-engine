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
import {
  buildMappingReasoning,
  computeSemanticSimilarity,
  findExplicitMapping,
} from "../utils/semantic-scoring.js";
import { normalizeToken } from "../data/logistics-synonyms.js";
import { detectSourceSystem } from "../utils/source-system.js";
import { promptBuilderService } from "./prompt-builder.service.js";
import { requiredFieldResolverService } from "./required-field-resolver.service.js";
import { semanticMatcherService } from "./semantic-matcher.service.js";
import type { CustomVocabularyStore } from "./custom-vocabulary.store.js";
import { vocabularyStore as defaultVocabularyStore } from "./custom-vocabulary.store.js";
import type { LearnedVocabularyStore } from "./learned-vocabulary.store.js";
import { learnedVocabularyStore as defaultLearnedVocabularyStore } from "./learned-vocabulary.store.js";
import type { SchemaFieldDescriptor } from "../models/schema-field.types.js";

const log = aiLog("ai-mapping");

export class AiMappingService {
  private anthropic: Anthropic | null = null;
  private readonly mappingCache = new Map<string, FieldMapping[]>();

  constructor(
    private readonly config = loadAiConfig(),
    private readonly vocabStore: CustomVocabularyStore = defaultVocabularyStore,
    private readonly learnedStore: LearnedVocabularyStore = defaultLearnedVocabularyStore,
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

    // ── Global learned vocabulary (accepted AI-fallback mappings) ─────────────
    // Second lookup after the heuristic: a hit is applied at confidence 1.0 like
    // any vocabulary match, so the field no longer counts as a gap that needs AI.
    const learnedMappings = await this.loadLearnedMappings(
      sourceAnalysis.fields,
      targetAnalysis.fields,
    );
    if (learnedMappings.length > 0) {
      mappings = applyVocabularyMappings(mappings, learnedMappings);
      log.info(
        { count: learnedMappings.length, fields: learnedMappings.map((m) => m.sourceField) },
        "Global custom vocabulary mappings applied",
      );
    }

    // ── Custom vocabulary injection (priority tier above heuristic) ───────────
    // Learned mappings come in at confidence 1.0 and displace any heuristic match
    // for the same source or target field. Fields covered here never reach AI.
    // Applied after the global list so a client's own vocabulary wins on conflict.
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
    const mappedSourcesBefore = new Set(mappings.map((m) => m.sourceField));
    const targetByPath = new Map(targetAnalysis.fields.map((f) => [f.path, f]));
    const unmappedRequiredBefore = targetAnalysis.fields
      .filter((f) => isTrulyUnmappedRequired(f, mappedTargets, targetByPath))
      .map((f) => f.path);

    // heuristicAvg only reflects the confidence of fields that DID map, and
    // hasUnmappedRequired only looks at unmapped TARGET fields that are schema-
    // required — neither notices plausible address/contact/identifier source data
    // (e.g. SAP's PSTLZ_E/REGIO_E/NAME1_E/TELF1_E) sitting unmapped simply because
    // nothing recognized it, while the fields that DID map happen to be genuinely
    // high-confidence. See isPlausibleUnmappedField below.
    const unmappedPlausibleFields = sourceAnalysis.fields
      .filter((f) => !mappedSourcesBefore.has(f.path) && isPlausibleUnmappedField(f))
      .map((f) => f.path);

    const noMappingsFound = mappings.length === 0;
    const belowThreshold = heuristicAvg < this.config.aiFallbackThreshold;
    const hasUnmappedRequired = unmappedRequiredBefore.length > 0;
    const hasUnmappedPlausibleFields = unmappedPlausibleFields.length > 0;

    const needsAi =
      this.config.aiFallbackEnabled &&
      this.anthropic &&
      (noMappingsFound || belowThreshold || hasUnmappedRequired || hasUnmappedPlausibleFields);

    let generationMode: "heuristic" | "hybrid" | "ai" = needsAi ? "hybrid" : "heuristic";

    // source→target pairs that existed before AI ran (heuristic + vocabulary), and
    // pairs the AI proposed. A final mapping is "from AI" only if it's in the second
    // set and not the first — those are what get queued in pending_vocabulary.
    const preAiKeys = new Set(mappings.map(mappingKey));
    const aiKeys = new Set<string>();

    // Routes the heuristic took via an explicit rule are deterministic decisions, not
    // guesses: AI may not re-route those sources or take those targets. Without this,
    // ShipStation's top-level /weight/value and /weight/units (rule-routed to the
    // required /packages[]/weight/*) lost to AI's exact-path /weight/* proposals in
    // deduplicateBySource, dropping the package weight and queuing the self-mappings
    // as "learned" vocabulary.
    const ruleRoutes = explicitRuleRoutes(mappings);

    log.info(
      {
        candidateCount: candidates.length,
        heuristicMappingCount: mappings.length,
        heuristicAvg,
        noMappingsFound,
        belowThreshold,
        hasUnmappedRequired,
        unmappedRequired: unmappedRequiredBefore,
        hasUnmappedPlausibleFields,
        unmappedPlausibleFields,
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
          unmappedPlausibleFields: unmappedPlausibleFields.length,
          reason: noMappingsFound
            ? "no_mappings_found"
            : belowThreshold
              ? "below_confidence_threshold"
              : hasUnmappedRequired
                ? "unmapped_required_fields"
                : "unmapped_plausible_source_fields",
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
      aiMappings = dropRuleConflicts(aiMappings, ruleRoutes);
      for (const m of aiMappings) aiKeys.add(mappingKey(m));
      mappings = mergeMappings(mappings, aiMappings);
      // Role-context guard must run BEFORE deduplication: remove cross-context AI mappings
      // before they can displace the correct heuristic mappings via deduplicateBySource.
      mappings = filterCrossContextMappings(mappings);
      mappings = deduplicateBySource(mappings);
      generationMode = "hybrid";

      const mappedAfterFirst = new Set(mappings.map((m) => m.targetField));
      const stillMissing = REQUIRED_TARGET_PATHS.filter(
        (p) => !mappedAfterFirst.has(p) && !isArrayParentMapped(p, mappedAfterFirst),
      );
      if (stillMissing.length > 0) {
        log.info({ stillMissing }, "Second AI pass for missing required fields");
        const focusedTargetAnalysis = {
          ...targetAnalysis,
          fields: targetAnalysis.fields.filter((f) => stillMissing.includes(f.path)),
        };
        const secondAiMappings = dropRuleConflicts(
          await this.invokeAiMappings(request, sourceAnalysis, focusedTargetAnalysis, candidates),
          ruleRoutes,
        );
        for (const m of secondAiMappings) aiKeys.add(mappingKey(m));
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

    // Customs line items: the per-commodity description and quantity siblings don't survive
    // deduplicateBySource when the same source also feeds /customs/contentsDescription or
    // /packages[]/quantity, and some carriers (e.g. DHL) declare currency once at the
    // shipment level rather than per line item. All are synthesized here, after dedup, so
    // they aren't clobbered by it.
    mappings = synthesizeLineItemSiblings(mappings, sourceAnalysis);
    mappings = injectLineItemCurrencyDefault(mappings, sourceAnalysis);

    // A customs line item is optional (the whole /customs block can be omitted), but one
    // that DOES exist is schema-required to carry description, quantity, and a full
    // unitValue (amount + currency) — a real commercial-invoice line, not a bare country
    // code. Seen live: a purely domestic US→US payload where the AI's only customs-ish
    // signal was a stray /CountryCode field; it mapped that alone to
    // /customs/lineItems[]/countryOfOrigin at 0.48 confidence, synthesizeLineItemSiblings
    // above correctly found no real description/quantity/value to fill in (there wasn't
    // any), and the result was a half-filled line item that fails validation on exactly
    // the fields that were never there to map. Shipping no customs data is correct for a
    // domestic shipment; shipping a line item missing its required fields is not — drop
    // customs/lineItems[] mappings entirely rather than emit one that can't be complete.
    mappings = enforceCustomsLineItemCompleteness(mappings);

    // /customs/contentsType has a fixed canonical enum; force the normalization step
    // regardless of what heuristic/AI proposed, the same way parcel unit targets are
    // deterministically overridden above.
    mappings = enforceContentsTypeNormalization(mappings);

    // /serviceLevel has the same fixed-enum shape as contentsType, and the same gap:
    // every carrier exposes this as its own product/service code (DHL "P", UPS "03",
    // FedEx "FEDEX_GROUND") rather than the canonical economy/standard/express/
    // overnight/same_day vocabulary. The service_level concept's own canonicalPaths
    // list /serviceLevel alongside /carrier/serviceCode (see logistics-synonyms.ts), so
    // whenever the heuristic or AI resolves a source field to /serviceLevel specifically
    // -- e.g. a source field literally named "serviceLevel" wins the exact-name tie-break
    // over /carrier/serviceCode -- a bare "direct" transform ships the raw carrier code
    // straight into an enum field it was never going to satisfy. Force the normalization
    // step the same way contentsType's is forced above.
    mappings = enforceServiceLevelNormalization(mappings);

    // SAP delivery documents share one weight-unit field (GEWEI) across both net (NTGEW)
    // and gross (BRGEW) weight in the same record. GEWEI is already wired to
    // /packages[]/weight/unit; when BRGEW (or any source) lands on the top-level
    // /weight/value with no unit sibling, borrow GEWEI for /weight/unit too — same
    // shipment-level-value-fills-a-per-item-gap pattern as the customs currency default.
    mappings = injectTopLevelWeightUnitDefault(mappings, sourceAnalysis);

    // Any target whose schema declares format: "date" or "date-time" has exactly one
    // correct date step (date:date vs date:iso8601) — that's a fixed fact readable off the
    // target schema, not a judgment call. Enforced deterministically here for every such
    // target rather than trusting whichever step the heuristic/AI happened to pick, the
    // same way contentsType's enum is above. This used to be hardcoded to just
    // /metadata/createdAt and /updatedAt; generalized after finding /estimatedDelivery/
    // dateTime, /timeWindowStart, /timeWindowEnd, and the response schema's top-level
    // /createdAt have the identical exposure with zero coverage.
    mappings = enforceDateFormatTransformation(mappings, targetByPath);

    // Any target whose schema allows exactly one non-null scalar type must receive a
    // value of that type. Same rationale as the date-format enforcement just above: the
    // AI's own reasoning/transformation choice is not a reliable signal — seen both as
    // /shipments[]/shipmentId -> /identifiers/shipmentId landing as a bare number (string
    // target, "direct" with no cast) and as EasyPost's /parcel/height|length|width landing
    // as bare strings on /packages[]/dimensions/* (number target, same gap, opposite type).
    mappings = enforceScalarCastTransformation(mappings, targetByPath);

    // Partition by autoApplyThreshold: candidates strictly below go to review, not auto-apply
    const { autoApplyThreshold } = this.config;
    const lowConfidenceMappings = mappings.filter((m) => m.confidence < autoApplyThreshold);
    mappings = mappings.filter((m) => m.confidence >= autoApplyThreshold);

    if (aiKeys.size > 0) {
      await this.recordPendingVocabulary(
        [...mappings, ...lowConfidenceMappings],
        preAiKeys,
        aiKeys,
        sourceAnalysis,
        targetAnalysis.schemaId,
        clientId,
      );
    }

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
      log.warn(
        { responseLength: completionText.length },
        "AI response could not be parsed into a mappings array — parseAiResponse returned null or no mappings key",
      );
      return [];
    }

    const validTargetPaths = new Set(targetAnalysis.fields.map((f) => f.path));

    const filtered = parsed.mappings
      .filter((m) => m.sourceField && m.targetField)
      .filter((m) => validTargetPaths.has(m.targetField));

    log.info(
      { parsedCount: parsed.mappings.length, acceptedCount: filtered.length },
      "AI mapping response parsed",
    );

    return filtered.map((m) => ({
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
    } catch (err) {
      log.error(
        {
          error: err instanceof Error ? err.message : String(err),
          responseLength: text.length,
          responseHead: jsonText.slice(0, 500),
          responseTail: jsonText.slice(-500),
        },
        "Failed to parse AI mapping response as JSON",
      );
      return null;
    }
  }

  // ── Vocabulary helpers ──────────────────────────────────────────────────────

  /** Global learned vocabulary → FieldMappings. Matches on exact source path only. */
  private async loadLearnedMappings(
    sourceFields: SchemaFieldDescriptor[],
    targetFields: SchemaFieldDescriptor[],
  ): Promise<FieldMapping[]> {
    let vocab;
    try {
      vocab = await this.learnedStore.loadCustom();
    } catch (err) {
      log.error({ err }, "Failed to load global custom vocabulary — continuing without it");
      return [];
    }
    if (vocab.size === 0) return [];

    const validTargetPaths = new Set(targetFields.map((f) => f.path));
    const mappings: FieldMapping[] = [];
    for (const sf of sourceFields) {
      if (sf.kind === "object") continue;
      const hit = vocab.get(sf.path);
      if (!hit || !validTargetPaths.has(hit.canonicalField)) continue;
      mappings.push({
        sourceField: sf.path,
        targetField: hit.canonicalField,
        confidence: CUSTOM_VOCAB_CONFIDENCE,
        transformation: hit.transformation,
        reasoning: `Custom vocabulary (global): '${sf.path}' was accepted as '${hit.canonicalField}'.`,
      });
    }
    return mappings;
  }

  /**
   * Queue final mappings that originated from the AI fallback for accept/reject.
   * Never fails the mapping request — a store error is logged and swallowed.
   */
  private async recordPendingVocabulary(
    finalMappings: FieldMapping[],
    preAiKeys: Set<string>,
    aiKeys: Set<string>,
    sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
    targetSchemaId: string | undefined,
    clientId: string | undefined,
  ): Promise<void> {
    const sourcePaths = new Set(sourceAnalysis.fields.map((f) => f.path));
    // Exact-path pairs are never vocabulary: the heuristic resolves them itself.
    const fromAi = finalMappings.filter((m) => {
      const key = mappingKey(m);
      return (
        aiKeys.has(key) &&
        !preAiKeys.has(key) &&
        sourcePaths.has(m.sourceField) &&
        !isExactPathPair(m)
      );
    });
    if (fromAi.length === 0) return;

    // One check per request, against the whole payload's field paths — not per field.
    // Whichever known carrier/ERP schema this payload matches (if any) applies to
    // every AI-fallback field recorded from it.
    const detectedSourceSystem = detectSourceSystem(sourcePaths);

    try {
      const recorded = await this.learnedStore.recordPending(
        fromAi.map((m) => ({
          sourceField: m.sourceField,
          targetField: m.targetField,
          transformation: m.transformation,
          confidence: m.confidence,
          reasoning: m.reasoning,
          context: { sourceSchemaId: sourceAnalysis.schemaId, targetSchemaId, clientId },
          detectedSourceSystem,
        })),
      );
      log.info(
        { count: recorded.length, ids: recorded.map((e) => e.id) },
        "AI fallback mappings queued in pending vocabulary",
      );
    } catch (err) {
      log.error({ err }, "Failed to record pending vocabulary — mapping result unaffected");
    }
  }

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

// ─── Customs line item completion ────────────────────────────────────────────
// Commercial-invoice line items require description, quantity, and unitValue.
// Carriers commonly provide these as siblings under one commodity/line-item
// object, but two structural gaps keep them from landing on their own:
//  1. The commodity description also legitimately maps to /customs/contentsDescription
//     (the customs-level summary). deduplicateBySource keeps only the higher-confidence
//     target per source field, so the line-item description silently drops.
//  2. Some carriers (DHL) declare currency once at the shipment level, not per line
//     item, so there is no direct source field for /customs/lineItems[]/unitValue/currency.
//
// Gap 1 applies equally to quantity: the commodity quantity also legitimately feeds
// /packages[]/quantity, and which of the two survives deduplicateBySource depends on
// relative heuristic/AI confidence — so it flipped between runs on the same DHL payload.
// Both required siblings are re-attached here, after dedup, from the commodity parent
// of whichever customs line item fields did map.

interface LineItemSibling {
  targetField: string;
  /** Accepted source leaf names (normalizeToken form) */
  names: string[];
  transformation: string;
  /** Other target the same source legitimately feeds (for the reasoning string) */
  alsoFeeds: string;
}

const LINE_ITEM_SIBLINGS: LineItemSibling[] = [
  {
    targetField: "/customs/lineItems[]/description",
    names: ["description"],
    transformation: "direct",
    alsoFeeds: "/customs/contentsDescription",
  },
  {
    targetField: "/customs/lineItems[]/quantity",
    names: ["quantity", "qty"],
    // Line item quantity is schema type integer; carriers sometimes send it as a string.
    transformation: "cast:number",
    alsoFeeds: "/packages[]/quantity",
  },
];

function synthesizeLineItemSiblings(
  mappings: FieldMapping[],
  sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
): FieldMapping[] {
  const additions: FieldMapping[] = [];

  for (const sibling of LINE_ITEM_SIBLINGS) {
    if (mappings.some((m) => m.targetField === sibling.targetField)) continue;

    // Commodity parents: source parents of every other mapped customs line item field.
    const parentPaths = new Set(
      mappings
        .filter((m) => m.targetField.startsWith("/customs/lineItems[]/") && m.targetField !== sibling.targetField)
        .map((m) => m.sourceField.replace(/\/[^/]+$/, "")),
    );
    if (parentPaths.size === 0) continue;

    const field = sourceAnalysis.fields.find(
      (f) =>
        f.kind !== "object" &&
        f.parentPath !== undefined &&
        parentPaths.has(f.parentPath) &&
        sibling.names.includes(normalizeToken(f.name)),
    );
    if (!field) continue;

    log.info(
      { sourceField: field.path, targetField: sibling.targetField },
      "Synthesized customs line item sibling mapping",
    );
    additions.push({
      sourceField: field.path,
      targetField: sibling.targetField,
      confidence: 0.85,
      transformation: sibling.transformation,
      reasoning: `${field.path} is the per-commodity sibling of the already-mapped customs line item fields; it also feeds ${sibling.alsoFeeds}, but deduplication only keeps one target per source field.`,
    });
  }

  return additions.length > 0 ? [...mappings, ...additions] : mappings;
}

const LINE_ITEM_CURRENCY_PATTERNS: RegExp[] = [
  /\/DeclaredValueCurrecyCode$/i,
];

function injectLineItemCurrencyDefault(
  mappings: FieldMapping[],
  sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
): FieldMapping[] {
  const hasLineItemAmount = mappings.some((m) => m.targetField === "/customs/lineItems[]/unitValue/amount");
  const alreadyMapped = mappings.some((m) => m.targetField === "/customs/lineItems[]/unitValue/currency");
  if (!hasLineItemAmount || alreadyMapped) return mappings;

  const currencyField = sourceAnalysis.fields.find((f) =>
    LINE_ITEM_CURRENCY_PATTERNS.some((p) => p.test(f.path)),
  );
  if (!currencyField) return mappings;

  log.info(
    { sourceField: currencyField.path, targetField: "/customs/lineItems[]/unitValue/currency" },
    "Injected shipment-level currency default for customs line items",
  );

  return [
    ...mappings,
    {
      sourceField: currencyField.path,
      targetField: "/customs/lineItems[]/unitValue/currency",
      confidence: 0.8,
      transformation: "cast:string|normalize:currency",
      reasoning:
        "DHL declares currency once at the shipment level (DeclaredValueCurrecyCode); applied to every " +
        "customs line item's unitValue since there is no per-line-item currency field.",
    },
  ];
}

/** Every target leaf a customs line item needs to pass schema validation (unitValue is itself required amount+currency). */
const REQUIRED_LINE_ITEM_TARGETS = [
  "/customs/lineItems[]/description",
  "/customs/lineItems[]/quantity",
  "/customs/lineItems[]/unitValue/amount",
  "/customs/lineItems[]/unitValue/currency",
];

function enforceCustomsLineItemCompleteness(mappings: FieldMapping[]): FieldMapping[] {
  const lineItemMappings = mappings.filter((m) => m.targetField.startsWith("/customs/lineItems[]/"));
  if (lineItemMappings.length === 0) return mappings;

  const covered = new Set(lineItemMappings.map((m) => m.targetField));
  const missingRequired = REQUIRED_LINE_ITEM_TARGETS.filter((t) => !covered.has(t));
  if (missingRequired.length === 0) return mappings;

  log.info(
    {
      droppedTargets: lineItemMappings.map((m) => m.targetField),
      droppedSources: lineItemMappings.map((m) => m.sourceField),
      missingRequired,
    },
    "Dropping incomplete customs line item mappings — can't cover every required field",
  );

  return mappings.filter((m) => !m.targetField.startsWith("/customs/lineItems[]/"));
}

const TOP_LEVEL_WEIGHT_UNIT_PATTERNS: RegExp[] = [
  /^\/GEWEI$/i,
];

function injectTopLevelWeightUnitDefault(
  mappings: FieldMapping[],
  sourceAnalysis: ReturnType<typeof semanticMatcherService.analyzeSchema>,
): FieldMapping[] {
  const hasTopLevelWeightValue = mappings.some((m) => m.targetField === "/weight/value");
  const alreadyMapped = mappings.some((m) => m.targetField === "/weight/unit");
  if (!hasTopLevelWeightValue || alreadyMapped) return mappings;

  const unitField = sourceAnalysis.fields.find((f) =>
    TOP_LEVEL_WEIGHT_UNIT_PATTERNS.some((p) => p.test(f.path)),
  );
  if (!unitField) return mappings;

  log.info(
    { sourceField: unitField.path, targetField: "/weight/unit" },
    "Injected shipment-level weight unit default from shared SAP unit field",
  );

  return [
    ...mappings,
    {
      sourceField: unitField.path,
      targetField: "/weight/unit",
      confidence: 0.9,
      transformation: "cast:string|normalize:weightUnit",
      reasoning:
        "SAP delivery documents share one weight-unit field (GEWEI) across both net (NTGEW) and " +
        "gross (BRGEW) weight in the same record; applied here since /weight/value is mapped but " +
        "has no unit of its own.",
    },
  ];
}

function enforceContentsTypeNormalization(mappings: FieldMapping[]): FieldMapping[] {
  return mappings.map((m) =>
    m.targetField === "/customs/contentsType" && !m.transformation.includes("normalize:contentsType")
      ? { ...m, transformation: "cast:string|normalize:contentsType" }
      : m,
  );
}

function enforceServiceLevelNormalization(mappings: FieldMapping[]): FieldMapping[] {
  return mappings.map((m) =>
    m.targetField === "/serviceLevel" && !m.transformation.includes("normalize:serviceLevel")
      ? { ...m, transformation: "cast:string|normalize:serviceLevel" }
      : m,
  );
}

/**
 * Any target field whose schema declares `format: "date"` or `format: "date-time"` has
 * exactly one transformation that can possibly produce a schema-valid result — read
 * directly off the target schema, not guessed from the target path's name (which is what
 * both isDeliveryDateMapping and the AI itself otherwise rely on, and neither covers every
 * date-ish target). Enforced for both directions: a date-time value into a strict
 * `format: "date"` target (e.g. ajv's date-time string into /estimatedDelivery/date) is
 * just as invalid as the reverse.
 */
function enforceDateFormatTransformation(
  mappings: FieldMapping[],
  targetByPath: Map<string, SchemaFieldDescriptor>,
): FieldMapping[] {
  return mappings.map((m) => {
    const format = targetByPath.get(m.targetField)?.metadata?.format;
    if (format !== "date" && format !== "date-time") return m;

    const correctStep = format === "date-time" ? "date:iso8601" : "date:date";
    const hasArrayFirst = m.transformation.split("|").includes("array:first");
    const transformation = hasArrayFirst ? `array:first|${correctStep}` : correctStep;
    return m.transformation === transformation ? m : { ...m, transformation };
  });
}

/**
 * Any target field whose schema allows exactly one non-null scalar type must end up as
 * a value of that type. Read directly off the target schema's resolved `types` (same
 * source enforceDateFormatTransformation reads `format` from), not inferred from the
 * mapping's own reasoning text or whichever transformation step the heuristic/AI happened
 * to pick. Neither is a reliable signal:
 *   - /shipments[]/shipmentId -> /identifiers/shipmentId (string target) was proposed as
 *     "direct" with reasoning "already string in target," but the source was numeric.
 *   - EasyPost's /parcel/height|length|width -> /packages[]/dimensions/* (number target)
 *     were proposed as "direct" with no cast at all, but EasyPost sends them as strings.
 * Same gap, opposite type — hence one scalar-type-driven function instead of two
 * single-type ones. Each cast step is a no-op when the value already has the target
 * type (String(x) on a string, Number(x) on a number, the boolean branch of cast:boolean
 * on a boolean) and passes null/undefined through unchanged, so applying it
 * unconditionally is safe rather than only when some pattern suggests a mismatch.
 * Date/date-time targets are excluded since enforceDateFormatTransformation above
 * already forces the correct step for those (also string-typed, but date:iso8601/
 * date:date already produce a string; this would just be a redundant no-op on top).
 */
const SCALAR_CAST_STEP_BY_TYPE: Record<string, string> = {
  string: "cast:string",
  number: "cast:number",
  integer: "cast:number",
  boolean: "cast:boolean",
};

// Steps that already satisfy a given cast, so enforcement is a no-op.
const SCALAR_CAST_SATISFIED_BY: Record<string, string[]> = {
  "cast:string": ["cast:string", "toString"],
  "cast:number": ["cast:number"],
  "cast:boolean": ["cast:boolean"],
};

function enforceScalarCastTransformation(
  mappings: FieldMapping[],
  targetByPath: Map<string, SchemaFieldDescriptor>,
): FieldMapping[] {
  return mappings.map((m) => {
    const target = targetByPath.get(m.targetField);
    if (!target || target.types.length !== 1) return m;

    const castStep = SCALAR_CAST_STEP_BY_TYPE[target.types[0]];
    if (!castStep) return m;

    const format = target.metadata?.format;
    if (format === "date" || format === "date-time") return m;

    const steps = m.transformation.split("|").map((s) => s.trim());
    if (SCALAR_CAST_SATISFIED_BY[castStep].some((s) => steps.includes(s))) return m;

    return { ...m, transformation: `${m.transformation}|${castStep}` };
  });
}

// ── Plausible-unmapped-field gate (hasUnmappedPlausibleFields) ───────────────
//
// Catches address/contact/identifier-shaped source fields left unmapped after
// the heuristic pass, even when they aren't schema-required and the fields that
// DID map are genuinely high-confidence. This can't rely on already recognizing
// the field's meaning (LOGISTICS_CONCEPTS/EXPLICIT_PATH_MAPPINGS already do that,
// and if they matched, the field wouldn't be unmapped) — so it uses two
// carrier-agnostic, language-agnostic-ish signals instead:
//   1. The field's example value has a recognizable shape (postal code, phone,
//      email) regardless of what the field happens to be named.
//   2. The field's name carries a common identity/contact stem, including SAP/EDI
//      abbreviations (PSTLZ, TELF) not covered by LOGISTICS_CONCEPTS' synonyms.
// This is deliberately a cheap trigger signal, not a mapping decision — AI still
// has to work out where each field actually goes.

const PLAUSIBLE_FIELD_NAME_STEMS = [
  "name", "company", "contact", "person",
  "email", "phone", "telephone", "mobile", "fax",
  "region", "state", "province",
  // SAP/EDI abbreviations: PSTLZ (Postleitzahl/postal code), TELF (Telefon/phone),
  // REGIO (Region). Listed explicitly rather than relying on "region" above —
  // normalizeToken strips the field's underscore separator (REGIO_E -> "regioe"),
  // which does not contain the substring "region".
  "pstlz", "telf", "regio",
  // Tracking-number backstop: a concept-only semantic match (see
  // semantic-scoring.ts's tracking_number floor) usually clears the heuristic now, but
  // this gate still needs its own signal so a tracking-shaped field that the heuristic
  // genuinely misses doesn't silently vanish instead of triggering AI. "tracking" alone
  // covers trackingNumber/masterTrackingNumber/shipmentTrackingNumber; UPS's
  // ShipmentIdentificationNumber needs its own stem since it contains neither
  // "tracking" nor "waybill". Not "pro" (pronumber) — too short, false-positives on
  // "province"/"product"/"process".
  "tracking", "waybill", "trackid", "shipmentidentification",
];

function looksLikePostalCode(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(value) && /\d/.test(value);
}

function looksLikePhoneNumber(value: string): boolean {
  return /^\+?[0-9][0-9()\- .]{6,17}$/.test(value);
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isPlausibleUnmappedField(field: SchemaFieldDescriptor): boolean {
  if (field.kind !== "primitive") return false;

  const nameNorm = normalizeToken(field.name);
  if (PLAUSIBLE_FIELD_NAME_STEMS.some((stem) => nameNorm.includes(stem))) {
    return true;
  }

  if (typeof field.exampleValue === "string") {
    const v = field.exampleValue.trim();
    return looksLikePostalCode(v) || looksLikePhoneNumber(v) || looksLikeEmail(v);
  }

  return false;
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
  if (field.kind === "array" && isArrayParentMapped(field.path, mappedTargets)) return false;

  return isAncestorChainRequired(field.path, byPath);
}

/**
 * An array parent path (e.g. /packages) is never a literal mapping target —
 * the executor creates the array as a side effect of mapping its children
 * (e.g. /packages[]/weight/value). So the parent counts as satisfied once
 * any child leaf path is mapped.
 */
function isArrayParentMapped(path: string, mappedTargets: Set<string>): boolean {
  const childPrefix = `${path.replace(/\[\]$/, "")}[]/`;
  return [...mappedTargets].some((t) => t.startsWith(childPrefix));
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

function mappingKey(m: Pick<FieldMapping, "sourceField" | "targetField">): string {
  return `${m.sourceField}\u0000${m.targetField}`;
}

/** Source and target are the same path (ignoring array markers and case). */
function isExactPathPair(m: Pick<FieldMapping, "sourceField" | "targetField">): boolean {
  const norm = (p: string) => p.replace(/\[\]/g, "").toLowerCase();
  return norm(m.sourceField) === norm(m.targetField);
}

interface RuleRoutes {
  pairs: Set<string>;
  sources: Set<string>;
  targets: Set<string>;
}

/** Pre-AI mappings that an explicit EXPLICIT_PATH_MAPPINGS rule produced. */
function explicitRuleRoutes(mappings: FieldMapping[]): RuleRoutes {
  const routes: RuleRoutes = { pairs: new Set(), sources: new Set(), targets: new Set() };
  for (const m of mappings) {
    if (!findExplicitMapping(m.sourceField, m.targetField)) continue;
    routes.pairs.add(mappingKey(m));
    routes.sources.add(m.sourceField);
    routes.targets.add(m.targetField);
  }
  return routes;
}

/** Drop AI proposals that would re-route a rule-routed source or take a rule-routed target. */
function dropRuleConflicts(ai: FieldMapping[], routes: RuleRoutes): FieldMapping[] {
  if (routes.pairs.size === 0) return ai;
  const kept = ai.filter(
    (m) =>
      routes.pairs.has(mappingKey(m)) ||
      (!routes.sources.has(m.sourceField) && !routes.targets.has(m.targetField)),
  );
  if (kept.length < ai.length) {
    log.info(
      {
        dropped: ai
          .filter((m) => !kept.includes(m))
          .map((m) => `${m.sourceField} -> ${m.targetField}`),
      },
      "AI proposals dropped: conflict with explicit-rule routes",
    );
  }
  return kept;
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
