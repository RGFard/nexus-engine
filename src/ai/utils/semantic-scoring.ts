import {
  CONTEXT_KEYWORDS,
  EXPLICIT_PATH_MAPPINGS,
  LOGISTICS_CONCEPTS,
  normalizeToken,
} from "../data/logistics-synonyms.js";
import type { SchemaFieldDescriptor } from "../models/schema-field.types.js";

export interface SimilarityBreakdown {
  name: number;
  semantic: number;
  description: number;
  parentContext: number;
  path: number;
  typeOrExample: number;
  total: number;
  reasons: string[];
}

export function resolveFieldContext(field: SchemaFieldDescriptor): string | undefined {
  const pathLower = field.path.toLowerCase();
  for (const [ctx, patterns] of Object.entries(CONTEXT_KEYWORDS)) {
    if (patterns.some((p) => p.test(pathLower) || p.test(field.name))) {
      return ctx;
    }
  }
  if (field.parentPath) {
    const parent = field.parentPath.toLowerCase();
    for (const [ctx, patterns] of Object.entries(CONTEXT_KEYWORDS)) {
      if (patterns.some((p) => p.test(parent))) {
        return ctx;
      }
    }
  }
  return undefined;
}

export function resolveConceptId(field: SchemaFieldDescriptor): string | undefined {
  const nameNorm = normalizeToken(field.name);
  const pathNorm = normalizeToken(field.path.replace(/\//g, "_"));

  for (const concept of LOGISTICS_CONCEPTS) {
    if (concept.synonyms.some((s) => nameNorm.includes(s) || s === nameNorm)) {
      if (!concept.contexts?.length) {
        return concept.id;
      }
      const ctx = resolveFieldContext(field);
      if (!ctx || concept.contexts.includes(ctx)) {
        return concept.id;
      }
    }
    if (concept.canonicalPaths.some((p) => pathNorm.endsWith(normalizeToken(p)))) {
      return concept.id;
    }
  }
  return undefined;
}

export function conceptForCanonicalPath(targetPath: string): string | undefined {
  const norm = targetPath.toLowerCase();
  for (const concept of LOGISTICS_CONCEPTS) {
    if (concept.canonicalPaths.some((p) => norm === p.toLowerCase() || norm.endsWith(p.toLowerCase().replace("[]", "")))) {
      return concept.id;
    }
  }
  return undefined;
}

export function findExplicitMapping(
  sourcePath: string,
  targetPath: string,
): { confidence: number; reasoning: string } | undefined {
  const sourceLeaf = sourcePath.split("/").filter(Boolean).pop() ?? "";
  for (const rule of EXPLICIT_PATH_MAPPINGS) {
    if (rule.sourcePattern.test(sourceLeaf) || rule.sourcePattern.test(sourcePath)) {
      const targetNorm = targetPath.replace(/\[\]/g, "");
      const ruleNorm = rule.targetPath.replace(/\[\]/g, "");
      // When a targetPattern is provided, use it for exact target matching instead of
      // the generic endsWith(lastSegment) fallback which can spuriously match common segments.
      const targetMatches = rule.targetPattern
        ? rule.targetPattern.test(targetPath)
        : targetNorm === ruleNorm || targetPath.endsWith(rule.targetPath.split("/").pop()!);
      if (targetMatches) {
        return { confidence: rule.confidence, reasoning: rule.reasoning };
      }
    }
  }
  return undefined;
}

export function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/[^a-z0-9]+/).filter(Boolean));
  const tokensB = new Set(b.split(/[^a-z0-9]+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) {
      intersection++;
    }
  }
  return intersection / Math.max(tokensA.size, tokensB.size);
}

export function computeSemanticSimilarity(
  source: SchemaFieldDescriptor,
  target: SchemaFieldDescriptor,
): SimilarityBreakdown {
  const reasons: string[] = [];
  let name = 0;
  let semantic = 0;
  let description = 0;
  let parentContext = 0;
  let path = 0;
  let typeOrExample = 0;

  const sourceNorm = normalizeToken(source.name);
  const targetNorm = normalizeToken(target.name);

  const explicit = findExplicitMapping(source.path, target.path);
  if (explicit) {
    return {
      name: 0.9,
      semantic: 0.95,
      description: 0.5,
      parentContext: 0.8,
      path: 0.85,
      typeOrExample: 0,
      total: explicit.confidence,
      reasons: ["explicit_logistics_mapping", explicit.reasoning],
    };
  }

  const sourceCtx = resolveFieldContext(source);
  const targetCtx = resolveFieldContext(target);

  if (sourceNorm === targetNorm) {
    name = 0.9;
    reasons.push("exact_name_match");
    if (sourceCtx && targetCtx && sourceCtx === targetCtx) {
      semantic = 0.88;
      parentContext = 0.9;
      reasons.push("same_name_same_parent_context");
    }
  } else {
    const nameSim = tokenSimilarity(sourceNorm, targetNorm);
    name = nameSim * 0.85;
    if (nameSim > 0.55) {
      reasons.push("name_token_similarity");
    }
  }

  const sourceConcept = resolveConceptId(source) ?? conceptForCanonicalPath(source.path);
  const targetConcept = resolveConceptId(target) ?? conceptForCanonicalPath(target.path);

  if (sourceConcept && targetConcept && sourceConcept === targetConcept) {
    semantic = 0.92;
    const concept = LOGISTICS_CONCEPTS.find((c) => c.id === sourceConcept);
    reasons.push(`semantic_concept:${sourceConcept}`);
    if (concept) {
      reasons.push(concept.label);
    }
  } else if (sourceConcept || targetConcept) {
    const partial = tokenSimilarity(sourceConcept ?? "", targetConcept ?? "");
    semantic = partial * 0.4;
  }

  if (source.description && target.description) {
    const descSim = tokenSimilarity(
      source.description.toLowerCase(),
      target.description.toLowerCase(),
    );
    description = descSim * 0.9;
    if (descSim > 0.35) {
      reasons.push("description_semantic_overlap");
    }
  }

  if (sourceCtx && targetCtx && sourceCtx === targetCtx && sourceNorm !== targetNorm) {
    parentContext = 0.85;
    reasons.push(`parent_context:${sourceCtx}`);
  } else if (
    source.parentPath &&
    target.parentPath &&
    tokenSimilarity(normalizeToken(source.parentPath), normalizeToken(target.parentPath)) > 0.5
  ) {
    parentContext = 0.6;
    reasons.push("parent_path_similarity");
  }

  const pathSim = tokenSimilarity(
    source.path.replace(/\[\]/g, ""),
    target.path.replace(/\[\]/g, ""),
  );
  path = pathSim * 0.7;
  if (pathSim > 0.5) {
    reasons.push("structural_path_similarity");
  }

  if (source.types.some((t) => target.types.includes(t))) {
    typeOrExample += 0.15;
    reasons.push("type_compatible");
  }

  if (source.exampleValue !== undefined && target.exampleValue !== undefined) {
    if (JSON.stringify(source.exampleValue) === JSON.stringify(target.exampleValue)) {
      typeOrExample += 0.25;
      reasons.push("example_value_match");
    } else if (
      typeof source.exampleValue === typeof target.exampleValue &&
      source.exampleValue !== null
    ) {
      typeOrExample += 0.1;
      reasons.push("example_type_match");
    }
  }

  const total = Math.min(
    1,
    name * 0.22 +
      semantic * 0.38 +
      description * 0.12 +
      parentContext * 0.14 +
      path * 0.08 +
      typeOrExample * 0.06,
  );

  return {
    name,
    semantic,
    description,
    parentContext,
    path,
    typeOrExample,
    total,
    reasons,
  };
}

export function buildMappingReasoning(
  source: SchemaFieldDescriptor,
  target: SchemaFieldDescriptor,
  breakdown: SimilarityBreakdown,
): string {
  const explicitReason = breakdown.reasons.find(
    (r) =>
      r !== "explicit_logistics_mapping" &&
      !r.startsWith("semantic_concept:") &&
      !r.startsWith("parent_context:") &&
      r.length > 20,
  );
  if (explicitReason) {
    return explicitReason;
  }

  const concept = resolveConceptId(source) ?? resolveConceptId(target);
  if (concept) {
    const meta = LOGISTICS_CONCEPTS.find((c) => c.id === concept);
    if (meta) {
      return `Both fields represent ${meta.label} (${source.path} → ${target.path}).`;
    }
  }

  if (breakdown.reasons.includes("exact_name_match")) {
    return `Field names match and describe the same attribute (${source.name}).`;
  }

  if (breakdown.semantic >= 0.7) {
    return `Strong semantic alignment between ${source.path} and ${target.path} based on logistics domain concepts.`;
  }

  if (breakdown.description > 0.4) {
    return `Schema descriptions indicate these fields serve the same purpose.`;
  }

  return `Mapped ${source.path} to ${target.path} based on combined name, context, and schema similarity.`;
}
