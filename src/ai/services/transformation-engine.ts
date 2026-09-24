import type { FieldMapping } from "../models/mapping.types.js";
import {
  normalizeDateForTarget,
  toCanonicalDateString,
  toCanonicalDateTimeString,
} from "../utils/date-normalize.js";
import { getByPath } from "../utils/json-path.js";

const UNIT_ALIASES: Record<string, string> = {
  lbs: "lb",
  kgs: "kg",
  ins: "in",
  cms: "cm",
};

// Canonical weight unit enum: ["kg", "lb", "g", "oz"] (from package.schema.json)
const WEIGHT_UNIT_MAP: Record<string, string> = {
  pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
  ounce: "oz", ounces: "oz", oz: "oz",
  kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg", kg: "kg", kgs: "kg", k: "kg",
  gram: "g", grams: "g", g: "g",
};

// Canonical dimension unit enum: ["cm", "in", "m"] (from package.schema.json)
const DIMENSION_UNIT_MAP: Record<string, string> = {
  inch: "in", inches: "in", in: "in",
  centimeter: "cm", centimeters: "cm", cm: "cm",
  meter: "m", meters: "m", m: "m",
  foot: "ft", feet: "ft", ft: "ft",
  millimeter: "mm", millimeters: "mm", mm: "mm",
};

export interface TransformContext {
  sourcePayload: unknown;
  mapping: FieldMapping;
}

/**
 * Applies a pipe-delimited transformation expression to a single source value.
 * Vocabulary aligns with transformation-generation.prompt.md
 */
export function applyTransformationSteps(
  value: unknown,
  transformation: string,
  context: TransformContext,
): unknown {
  const steps = transformation
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  let result: unknown = value;

  for (const step of steps) {
    result = applyStep(result, step, context);
  }

  return result;
}

function applyStep(value: unknown, step: string, context: TransformContext): unknown {
  if (step === "direct") {
    return value;
  }

  if (step === "cast:string" || step === "toString") {
    // toString: coerce number/boolean to string; pass null/undefined through unchanged
    return value === null || value === undefined ? value : String(value);
  }

  if (step === "cast:number") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }

  if (step === "cast:boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return Boolean(value);
  }

  if (step === "normalize:countryCode") {
    return typeof value === "string" ? value.toUpperCase().slice(0, 2) : value;
  }

  if (step === "normalize:currency") {
    return typeof value === "string" ? value.toUpperCase().slice(0, 3) : value;
  }

  if (step === "normalize:lowercase") {
    if (typeof value !== "string") {
      return value;
    }
    const lower = value.toLowerCase().trim();
    return UNIT_ALIASES[lower] ?? lower;
  }

  if (step === "normalize:weightUnit") {
    if (typeof value !== "string") {
      return value;
    }
    const lower = value.toLowerCase().trim();
    return WEIGHT_UNIT_MAP[lower] ?? lower;
  }

  if (step === "normalize:dimensionUnit") {
    if (typeof value !== "string") {
      return value;
    }
    const lower = value.toLowerCase().trim();
    return DIMENSION_UNIT_MAP[lower] ?? lower;
  }

  if (step === "date:date") {
    if (value === null || value === undefined) {
      return value;
    }
    return toCanonicalDateString(value) ?? value;
  }

  if (step === "date:iso8601" || step === "date:canonical") {
    if (value === null || value === undefined) {
      return value;
    }
    if (step === "date:canonical") {
      return normalizeDateForTarget(value, context.mapping.targetField);
    }
    return toCanonicalDateTimeString(value) ?? value;
  }

  if (step.startsWith("constant:")) {
    const raw = step.slice("constant:".length);
    return parseConstant(raw);
  }

  if (step === "extensions:passthrough") {
    return applyExtensionsPassthrough(value, context);
  }

  if (step.startsWith("wrap:")) {
    // wrap:key — wraps the value in { key: value } so it can be merged into the extensions bucket.
    // Used for reference IDs that need a stable, human-readable key (e.g. wrap:originRef).
    const key = step.slice("wrap:".length);
    if (!key) return value;
    return { [key]: value };
  }

  if (step.startsWith("concat:")) {
    return applyConcat(step, context);
  }

  if (step === "nested:object") {
    return value;
  }

  if (step === "array:first") {
    if (Array.isArray(value)) {
      return value.length === 0 ? undefined : value[0];
    }
    return value;
  }

  if (step === "array:map") {
    if (Array.isArray(value) && value.length === 0) {
      return undefined;
    }
    return value;
  }

  return value;
}

function applyExtensionsPassthrough(value: unknown, context: TransformContext): unknown {
  const targetField = context.mapping.targetField;
  const extensionsMatch = targetField.match(/\/extensions(?:\/(.+))?$/);

  if (extensionsMatch?.[1]) {
    return { [extensionsMatch[1]]: value };
  }

  const sourceLeaf = context.mapping.sourceField.split("/").filter(Boolean).pop();
  if (sourceLeaf && isPlainObject(value)) {
    return value;
  }
  if (sourceLeaf) {
    return { [sourceLeaf]: value };
  }

  return value;
}

function applyConcat(step: string, context: TransformContext): unknown {
  const fieldsPart = step.slice("concat:".length);
  const fields = fieldsPart.split(",").map((f) => f.trim()).filter(Boolean);

  if (fields.length === 0) {
    return "";
  }

  const parts = fields.map((field) => {
    const pointer = field.startsWith("/") ? field : `/${field}`;
    const v = getByPath(context.sourcePayload, pointer);
    return v === null || v === undefined ? "" : String(v);
  });

  return parts.join("");
}

function parseConstant(raw: string): unknown {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
