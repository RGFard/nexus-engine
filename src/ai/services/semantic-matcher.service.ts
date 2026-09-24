import type { CandidateMapping } from "../models/mapping.types.js";
import type {
  SchemaAnalysisResult,
  SchemaFieldDescriptor,
  SchemaFieldKind,
} from "../models/schema-field.types.js";
import {
  buildMappingReasoning,
  computeSemanticSimilarity,
  resolveFieldContext,
} from "../utils/semantic-scoring.js";
import { aiLog } from "../utils/ai-logger.js";
import type { SchemaRefResolver } from "./schema-ref-resolver.service.js";

const log = aiLog("semantic-matcher");

const MIN_PAIR_SCORE = 0.42;
const MIN_ACCEPT_SCORE = 0.48;
const HIGH_SEMANTIC_ACCEPT = 0.72;

export class SemanticMatcherService {
  private refResolver: SchemaRefResolver | null = null;

  setRefResolver(resolver: SchemaRefResolver): void {
    this.refResolver = resolver;
  }

  analyzeSchema(
    schema: Record<string, unknown>,
    examplePayload?: Record<string, unknown>,
    label = "schema",
  ): SchemaAnalysisResult {
    let effectiveSchema = schema;
    let fields = this.extractFields(effectiveSchema, "", examplePayload);

    const leafFields = fields.filter((f) => f.kind === "primitive" || f.kind === "array");
    const schemaHasProperties =
      Boolean((schema.properties as Record<string, unknown> | undefined) &&
        Object.keys(schema.properties as object).length > 0);

    if (leafFields.length === 0 && examplePayload && (label === "source" || !schemaHasProperties)) {
      effectiveSchema = this.inferSchemaFromPayload(examplePayload, label);
      fields = this.extractFields(effectiveSchema, "", examplePayload);
      log.info(
        { label, inferredFieldCount: fields.length },
        "Inferred source schema from payload (no schema properties)",
      );
    }

    if (leafFields.length === 0 && examplePayload && fields.length === 0) {
      fields = this.extractPayloadLeafFields(examplePayload);
      log.info(
        { label, payloadLeafCount: fields.length },
        "Extracted leaf fields directly from payload",
      );
    }

    const result: SchemaAnalysisResult = {
      schemaId: effectiveSchema.$id as string | undefined,
      title: effectiveSchema.title as string | undefined,
      version: effectiveSchema["x-canonical-version"] as string | undefined,
      domain: effectiveSchema["x-canonical-domain"] as string | undefined,
      fields,
    };

    log.info(
      {
        label,
        fieldCount: fields.length,
        leafFieldCount: fields.filter((f) => f.kind === "primitive" || f.kind === "array").length,
        schemaId: result.schemaId,
        samplePaths: fields.slice(0, 12).map((f) => f.path),
      },
      "Schema analysis complete",
    );

    return result;
  }

  findCandidateMappings(
    source: SchemaAnalysisResult,
    target: SchemaAnalysisResult,
  ): CandidateMapping[] {
    const sortedPairs: Array<{
      source: SchemaFieldDescriptor;
      target: SchemaFieldDescriptor;
      score: number;
      reasons: string[];
      reasoning: string;
    }> = [];

    for (const sf of source.fields) {
      if (sf.kind === "object") {
        continue;
      }
      for (const tf of target.fields) {
        if (tf.kind === "object") {
          continue;
        }
        const breakdown = computeSemanticSimilarity(sf, tf);
        if (breakdown.total >= MIN_PAIR_SCORE) {
          sortedPairs.push({
            source: sf,
            target: tf,
            score: breakdown.total,
            reasons: breakdown.reasons,
            reasoning: buildMappingReasoning(sf, tf, breakdown),
          });
        }
      }
    }

    // Role precedence regexes — compiled once outside the comparator
    const DEST_TGT_RE = /^\/destination/;
    const SHIP_TO_RE = /^\/shipto(?:\/|$)/i;
    const BILL_TO_RE = /^\/billto(?:\/|$)/i;

    // Exclude billTo-rooted sources from /destination/* targets: billTo is billing, not ship-to
    const eligiblePairs = sortedPairs.filter(
      (pair) => !(DEST_TGT_RE.test(pair.target.path) && BILL_TO_RE.test(pair.source.path)),
    );

    // Sort: for /destination/* targets shipTo-rooted sources always outrank others; otherwise by score
    eligiblePairs.sort((a, b) => {
      const aDestTgt = DEST_TGT_RE.test(a.target.path);
      const bDestTgt = DEST_TGT_RE.test(b.target.path);
      if (aDestTgt && bDestTgt) {
        const aShipTo = SHIP_TO_RE.test(a.source.path);
        const bShipTo = SHIP_TO_RE.test(b.source.path);
        if (aShipTo && !bShipTo) return -1;
        if (!aShipTo && bShipTo) return 1;
      }
      return b.score - a.score;
    });

    const usedSources = new Set<string>();
    const usedTargets = new Set<string>();
    const candidates: CandidateMapping[] = [];

    for (const pair of eligiblePairs) {
      if (usedSources.has(pair.source.path) || usedTargets.has(pair.target.path)) {
        continue;
      }

      const accept =
        pair.score >= MIN_ACCEPT_SCORE ||
        (pair.score >= 0.45 && pair.reasons.some((r) => r.startsWith("semantic_concept:"))) ||
        pair.score >= HIGH_SEMANTIC_ACCEPT;

      if (!accept) {
        continue;
      }

      usedSources.add(pair.source.path);
      usedTargets.add(pair.target.path);
      candidates.push({
        sourceField: pair.source.path,
        targetField: pair.target.path,
        confidence: Math.round(pair.score * 100) / 100,
        matchReasons: pair.reasons,
        reasoning: pair.reasoning,
      });
    }

    log.info(
      {
        candidateCount: candidates.length,
        sourceFields: source.fields.length,
        targetFields: target.fields.length,
        topMatches: candidates.slice(0, 8).map((c) => ({
          source: c.sourceField,
          target: c.targetField,
          confidence: c.confidence,
        })),
      },
      "Semantic candidates generated",
    );

    return candidates;
  }

  findUnmapped(
    analysis: SchemaAnalysisResult,
    mappedPaths: Set<string>,
  ): string[] {
    return analysis.fields
      .filter((f) => f.kind !== "metadata" && f.kind !== "object" && !mappedPaths.has(f.path))
      .map((f) => f.path)
      .sort();
  }

  /** Infer a minimal JSON Schema from a carrier payload for mapping tests */
  inferSchemaFromPayload(payload: Record<string, unknown>, title = "InferredSource"): Record<string, unknown> {
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      title,
      type: "object",
      additionalProperties: true,
      properties: inferProperties(payload),
    };
  }

  extractFields(
    schema: Record<string, unknown>,
    basePath: string,
    examplePayload?: Record<string, unknown>,
    isExtension = false,
  ): SchemaFieldDescriptor[] {
    const fields: SchemaFieldDescriptor[] = [];
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;

    if (!properties) {
      return fields;
    }

    const requiredSet = new Set((schema.required as string[] | undefined) ?? []);

    for (const [name, propSchema] of Object.entries(properties)) {
      const path = basePath ? `${basePath}/${name}` : `/${name}`;
      const childIsExtension = isExtension || name === "extensions";
      const exampleValue = examplePayload ? getByPath(examplePayload, path) : undefined;

      const resolved = this.resolveRef(propSchema, schema);
      const kind = this.inferKind(resolved, childIsExtension);
      const types = this.inferTypes(resolved);

      const field: SchemaFieldDescriptor = {
        path,
        name,
        kind,
        types,
        description: resolved.description as string | undefined,
        required: requiredSet.has(name),
        parentPath: basePath || undefined,
        isExtension: childIsExtension,
        metadata: this.extractFieldMetadata(resolved),
        exampleValue,
        parentContext: resolveFieldContext({
          path,
          name,
          parentPath: basePath || undefined,
        } as SchemaFieldDescriptor),
      };

      fields.push(field);

      if (kind === "object" && resolved.properties) {
        const nestedExample =
          exampleValue && typeof exampleValue === "object" && !Array.isArray(exampleValue)
            ? (exampleValue as Record<string, unknown>)
            : undefined;
        fields.push(
          ...this.extractFields(resolved, path, nestedExample, childIsExtension),
        );
      }

      if (kind === "array") {
        const items = resolved.items as Record<string, unknown> | undefined;
        if (items) {
          const itemResolved = this.resolveRef(items, schema);
          const arrayPath = `${path}[]`;
          const arrayExamples = Array.isArray(exampleValue) ? exampleValue : undefined;
          const firstExample = arrayExamples?.[0] as Record<string, unknown> | undefined;

          if (itemResolved.properties) {
            fields.push(
              ...this.extractFields(itemResolved, arrayPath, firstExample, childIsExtension),
            );
          } else {
            fields.push({
              path: arrayPath,
              name: `${name}[]`,
              kind: "primitive",
              types: this.inferTypes(itemResolved),
              description: itemResolved.description as string | undefined,
              required: requiredSet.has(name),
              parentPath: path,
              isExtension: childIsExtension,
              metadata: this.extractFieldMetadata(itemResolved),
              exampleValue: firstExample,
              parentContext: resolveFieldContext({
                path: arrayPath,
                name,
                parentPath: path,
              } as SchemaFieldDescriptor),
            });
          }
        }
      }
    }

    return fields;
  }

  private resolveRef(
    propSchema: Record<string, unknown>,
    root: Record<string, unknown>,
  ): Record<string, unknown> {
    const ref = propSchema.$ref as string | undefined;
    if (!ref) {
      return propSchema;
    }

    if (ref.startsWith("#/")) {
      const parts = ref.slice(2).split("/");
      let node: unknown = root;
      for (const part of parts) {
        if (node && typeof node === "object") {
          node = (node as Record<string, unknown>)[part];
        }
      }
      if (node && typeof node === "object") {
        return node as Record<string, unknown>;
      }
    }

    if (ref.startsWith("canonical://") && this.refResolver) {
      const external = this.refResolver.resolve(ref);
      if (external) {
        return external;
      }
    }

    return propSchema;
  }

  /** Walk payload tree and emit leaf field descriptors (nested objects + arrays). */
  extractPayloadLeafFields(
    payload: Record<string, unknown>,
    basePath = "",
    parentPath?: string,
  ): SchemaFieldDescriptor[] {
    const fields: SchemaFieldDescriptor[] = [];

    for (const [key, value] of Object.entries(payload)) {
      const path = basePath ? `${basePath}/${key}` : `/${key}`;
      const descriptor: SchemaFieldDescriptor = {
        path,
        name: key,
        kind: Array.isArray(value) ? "array" : typeof value === "object" && value !== null ? "object" : "primitive",
        types: [Array.isArray(value) ? "array" : typeof value],
        required: false,
        parentPath: basePath || undefined,
        isExtension: key === "extensions",
        metadata: {},
        exampleValue: value,
        parentContext: resolveFieldContext({
          path,
          name: key,
          parentPath: basePath || undefined,
        } as SchemaFieldDescriptor),
      };

      if (descriptor.kind === "primitive") {
        fields.push(descriptor);
      } else if (Array.isArray(value) && value[0] && typeof value[0] === "object") {
        fields.push(descriptor);
        fields.push(
          ...this.extractPayloadLeafFields(
            value[0] as Record<string, unknown>,
            `${path}[]`,
            path,
          ),
        );
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        fields.push(descriptor);
        fields.push(
          ...this.extractPayloadLeafFields(value as Record<string, unknown>, path, path),
        );
      }
    }

    return fields;
  }

  private inferKind(
    schema: Record<string, unknown>,
    isExtension: boolean,
  ): SchemaFieldKind {
    if (isExtension && schema.additionalProperties === true) {
      return "extension";
    }
    const type = schema.type;
    if (type === "array" || (Array.isArray(type) && type.includes("array"))) {
      return "array";
    }
    if (type === "object" || (Array.isArray(type) && type.includes("object"))) {
      return "object";
    }
    return "primitive";
  }

  private inferTypes(schema: Record<string, unknown>): string[] {
    const type = schema.type;
    if (typeof type === "string") {
      return [type];
    }
    if (Array.isArray(type)) {
      return type.filter((t): t is string => typeof t === "string" && t !== "null");
    }
    return ["unknown"];
  }

  private extractFieldMetadata(schema: Record<string, unknown>): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (schema.enum) {
      meta.enum = schema.enum;
    }
    if (schema.format) {
      meta.format = schema.format;
    }
    if (schema.title) {
      meta.title = schema.title;
    }
    if (schema.$id) {
      meta.id = schema.$id;
    }
    for (const key of Object.keys(schema)) {
      if (key.startsWith("x-canonical")) {
        meta[key] = schema[key];
      }
    }
    return meta;
  }
}

function inferProperties(
  value: unknown,
  depth = 0,
): Record<string, Record<string, unknown>> {
  if (depth > 6 || value === null || typeof value !== "object") {
    return {};
  }

  if (Array.isArray(value)) {
    const first = value[0];
    return {
      items: {
        type: "object",
        properties: inferProperties(first, depth + 1),
      },
    } as unknown as Record<string, Record<string, unknown>>;
  }

  const props: Record<string, Record<string, unknown>> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === null) {
      props[key] = { type: "null" };
    } else if (Array.isArray(child)) {
      props[key] = { type: "array", items: { type: "object", properties: inferProperties(child[0], depth + 1) } };
    } else if (typeof child === "object") {
      props[key] = { type: "object", properties: inferProperties(child, depth + 1) };
    } else {
      props[key] = { type: typeof child };
    }
  }
  return props;
}

function getByPath(obj: Record<string, unknown>, pointer: string): unknown {
  const segments = pointer.split("/").filter(Boolean);
  let current: unknown = obj;
  for (const seg of segments) {
    if (seg.endsWith("[]")) {
      const key = seg.slice(0, -2);
      if (current && typeof current === "object" && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[key];
      }
      if (Array.isArray(current)) {
        current = current[0];
      }
      continue;
    }
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

export const semanticMatcherService = new SemanticMatcherService();
