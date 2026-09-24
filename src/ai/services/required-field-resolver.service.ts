import type { SchemaAnalysisResult, SchemaFieldDescriptor } from "../models/schema-field.types.js";
import type { FieldMapping, RequiredFieldSuggestion } from "../models/mapping.types.js";
import { inferDeliveryDateTransformation } from "../utils/date-normalize.js";
import { buildMappingReasoning, computeSemanticSimilarity } from "../utils/semantic-scoring.js";
import { aiLog } from "../utils/ai-logger.js";

const log = aiLog("required-field-resolver");

export interface RequiredFieldResolverOptions {
  /** Apply default values for missing required targets when defined */
  defaults?: Record<string, unknown>;
  /** Suggest top-N source field candidates per missing required target */
  maxSuggestions?: number;
}

export class RequiredFieldResolverService {
  resolve(
    sourceAnalysis: SchemaAnalysisResult,
    targetAnalysis: SchemaAnalysisResult,
    mappings: FieldMapping[],
    options: RequiredFieldResolverOptions = {},
  ): {
    missingRequired: string[];
    suggestions: RequiredFieldSuggestion[];
    augmentedMappings: FieldMapping[];
  } {
    const mappedTargets = new Set(mappings.map((m) => m.targetField));
    const targetByPath = new Map(targetAnalysis.fields.map((f) => [f.path, f]));
    // Only suggest/auto-map fields whose entire ancestor chain is required.
    // Nested-in-optional-parent fields (customs, weight, metadata, etc.) must not
    // generate suggestions when those optional parents aren't in the payload.
    const requiredTargets = targetAnalysis.fields.filter(
      (f) => f.required && f.kind === "primitive" && isAncestorChainRequired(f.path, targetByPath),
    );

    const missingRequired: string[] = [];
    const suggestions: RequiredFieldSuggestion[] = [];
    const augmentedMappings = [...mappings];

    for (const targetField of requiredTargets) {
      if (mappedTargets.has(targetField.path)) {
        continue;
      }

      const isCoveredByParent = [...mappedTargets].some(
        (p) => targetField.path.startsWith(p + "/") || p.startsWith(targetField.path + "/"),
      );
      if (isCoveredByParent && targetField.kind !== "primitive") {
        continue;
      }

      missingRequired.push(targetField.path);

      const rankedSources = sourceAnalysis.fields
        .map((sf) => ({
          source: sf,
          breakdown: computeSemanticSimilarity(sf, targetField),
        }))
        .sort((a, b) => b.breakdown.total - a.breakdown.total)
        .slice(0, options.maxSuggestions ?? 3);

      const suggestedSourceFields = rankedSources.map((r) => r.source.path);
      const defaultValue = options.defaults?.[targetField.path];

      let strategy: RequiredFieldSuggestion["strategy"] = "map";
      if (defaultValue !== undefined) {
        strategy = "default";
      } else if (suggestedSourceFields.length === 0) {
        strategy = "constant";
      }

      suggestions.push({
        targetField: targetField.path,
        description: targetField.description,
        suggestedSourceFields,
        defaultValue,
        strategy,
        reasoning:
          suggestedSourceFields.length > 0
            ? `Required canonical field is unmapped; best semantic source candidates: ${suggestedSourceFields.join(", ")}.`
            : `Required canonical field ${targetField.path} has no semantic source candidate; consider a default or constant.`,
      });

      if (defaultValue !== undefined && strategy === "default") {
        const best = rankedSources[0]?.source;
        augmentedMappings.push({
          sourceField: best?.path ?? "/",
          targetField: targetField.path,
          confidence: 0.55,
          transformation: `constant:${JSON.stringify(defaultValue)}`,
          reasoning: `Applied default value strategy for required field ${targetField.path}.`,
        });
        mappedTargets.add(targetField.path);
      } else if (rankedSources[0] && rankedSources[0].breakdown.total >= 0.55) {
        const best = rankedSources[0];
        augmentedMappings.push({
          sourceField: best.source.path,
          targetField: targetField.path,
          confidence: Math.round(best.breakdown.total * 100) / 100,
          transformation: inferTransform(best.source.path, targetField.path),
          reasoning: buildMappingReasoning(best.source, targetField, best.breakdown),
        });
        mappedTargets.add(targetField.path);
      }
    }

    log.info(
      { missing: missingRequired.length, suggestions: suggestions.length },
      "Required field resolution completed",
    );

    return { missingRequired, suggestions, augmentedMappings };
  }
}

function inferTransform(sourcePath: string, targetPath: string): string {
  if (targetPath.includes("countryCode")) {
    return "direct|normalize:countryCode";
  }
  const deliveryTransform = inferDeliveryDateTransformation(sourcePath, targetPath);
  if (deliveryTransform) {
    return deliveryTransform;
  }
  if (sourcePath.includes("[]") && !targetPath.includes("[]")) {
    return "array:first|direct";
  }
  if (sourcePath.includes("[]") && targetPath.includes("[]")) {
    return "array:map";
  }
  return "direct";
}

/** Shared with ai-mapping.service — a field only counts as required when all its ancestors are too. */
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
      if (!parent || parent === "ROOT") return true;
      current = parent;
    } else {
      const stripped = current.replace(/\[\]$/, "");
      if (stripped === current) return true;
      current = stripped;
    }
  }
  return true;
}

export const requiredFieldResolverService = new RequiredFieldResolverService();
