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

// Canonical customs contentsType enum: ["merchandise", "documents", "gift",
// "returned_goods", "sample", "other", null] (from shipment-create-request.schema.json).
// DHL's Content field ("DOCUMENTS" / "NON_DOCUMENTS") is a documents/not-documents
// flag rather than a full category, so NON_DOCUMENTS maps to the closest general
// category, "merchandise".
const CONTENTS_TYPE_MAP: Record<string, string> = {
  documents: "documents",
  document: "documents",
  non_documents: "merchandise",
  nondocuments: "merchandise",
  merchandise: "merchandise",
  gift: "gift",
  sample: "sample",
  returned_goods: "returned_goods",
  return: "returned_goods",
  returns: "returned_goods",
};

// Canonical serviceLevel enum: ["economy", "standard", "express", "overnight",
// "same_day", null] (from shipment-create-request.schema.json). Carriers expose this
// as their own product code or service-type string rather than this fixed vocabulary
// (DHL "P"/"U"/"K"/"T", UPS "03"/"01"/"02", FedEx "FEDEX_GROUND"/"PRIORITY_OVERNIGHT",
// generic words like "ground" or "2-day"), so a direct passthrough into /serviceLevel
// fails enum validation on every carrier whose raw value isn't already one of the five
// canonical words. Unrecognized codes map to null (serviceLevel is nullable) rather than
// guessing, the same reasoning that routes an unmapped contentsType to "other" instead
// of failing -- except serviceLevel's enum has no catch-all value, so null is the only
// schema-valid "I don't know" result.
const SERVICE_LEVEL_MAP: Record<string, string> = {
  // Canonical words pass through unchanged.
  economy: "economy",
  standard: "standard",
  express: "express",
  overnight: "overnight",
  same_day: "same_day",
  sameday: "same_day",

  // Generic/common carrier vocabulary.
  ground: "standard",
  ground_home_delivery: "standard",
  home_delivery: "standard",
  priority: "express",
  expedited: "express",
  next_day: "overnight",
  nextday: "overnight",
  first_overnight: "overnight",
  second_day: "express",
  secondday: "express",
  "2_day": "express",
  "2day": "express",
  third_day: "standard",
  "3_day": "standard",
  "3day": "standard",

  // DHL Express product codes (letter codes from productCode / ServiceType).
  p: "express", // EXPRESS WORLDWIDE
  u: "express", // EXPRESS WORLDWIDE (nondoc)
  n: "express", // DOMESTIC EXPRESS
  k: "overnight", // EXPRESS 9:00
  t: "overnight", // EXPRESS 12:00
  y: "overnight", // EXPRESS 12:00 (nondoc)
  w: "economy", // ECONOMY SELECT

  // UPS numeric service codes.
  "01": "overnight", // Next Day Air
  "13": "overnight", // Next Day Air Saver
  "14": "overnight", // Next Day Air Early
  "02": "express", // 2nd Day Air
  "59": "express", // 2nd Day Air A.M.
  "07": "express", // Worldwide Express
  "08": "express", // Worldwide Expedited
  "03": "standard", // Ground
  "12": "standard", // 3 Day Select
  "11": "standard", // UPS Standard

  // FedEx service-type strings.
  fedex_ground: "standard",
  fedex_express_saver: "express",
  fedex_2_day: "express",
  fedex_2_day_am: "express",
  standard_overnight: "overnight",
  priority_overnight: "overnight",
  international_economy: "economy",
  international_priority: "express",
  international_first: "overnight",
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

  if (step === "normalize:contentsType") {
    if (typeof value !== "string") {
      return value;
    }
    const key = value.toLowerCase().trim().replace(/[\s-]+/g, "_");
    return CONTENTS_TYPE_MAP[key] ?? "other";
  }

  if (step === "normalize:serviceLevel") {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const key = value.toLowerCase().trim().replace(/[\s-]+/g, "_");
    return SERVICE_LEVEL_MAP[key] ?? null;
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
    return applyConcat(value, step, context);
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

function applyConcat(value: unknown, step: string, context: TransformContext): unknown {
  const fieldsPart = step.slice("concat:".length);
  const fields = fieldsPart.split(",").map((f) => f.trim()).filter(Boolean);

  if (fields.length === 0) {
    return "";
  }

  const parts = fields.map((field) => {
    // {N} or {[N]} indexes into the array value already resolved for this mapping's
    // source field (e.g. StreetLines → line1 taking element 0), rather than naming a
    // separate absolute source path like the comma-joined field case below. Both forms
    // are accepted because the model has produced either one for the same operation;
    // see transformation-generation.prompt.md for the documented canonical form.
    const indexMatch = field.match(/^\{\[?(\d+)\]?\}$/);
    if (indexMatch) {
      const v = Array.isArray(value) ? value[Number(indexMatch[1])] : undefined;
      return v === null || v === undefined ? "" : String(v);
    }

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
