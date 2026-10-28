import type { ErrorObject } from "ajv";
import type { SavedOutboundPlan } from "./outbound.types.js";

/** A target schema error, traced back to what the caller can fix. */
export interface ExplainedTargetError {
  /** Where the target schema failed, e.g. /requestedShipment/shipper/contact */
  instancePath: string;
  /** Plain message naming the canonical field and, when there is one, the header to send */
  message: string;
  /** The canonical field that fills the failing target field, when the plan maps one */
  canonicalField?: string;
  /** The request header that can supply the value instead, when the plan declares one */
  header?: string;
}

const PARTY: Record<string, string> = {
  origin: "shipper",
  destination: "recipient",
  carrier: "carrier",
  packages: "package",
  customs: "customs",
  identifiers: "shipment",
  weight: "shipment total",
};

/** /origin/phone -> "shipper phone", /carrier/accountNumber -> "carrier account number" */
export function describeCanonicalField(path: string): string {
  const parts = path.replace(/\[\]/g, "").split("/").filter(Boolean);
  const words = parts.map((p, i) => {
    if (i === 0 && PARTY[p]) return PARTY[p];
    const line = p.match(/^line(\d)$/);
    if (line) return `address line ${line[1]}`;
    return p.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  });
  return words.join(" ");
}

/** Positions and wildcards look the same: /recipients/0/x and /recipients[0]/x -> /recipients[]/x */
function generic(path: string): string {
  return path.replace(/\/(\d+)(?=\/|$)/g, "[]").replace(/\[\d+\]/g, "[]");
}

/** True when target field `field` is `path` or sits inside it. */
function covers(path: string, field: string): boolean {
  const p = generic(path);
  const f = generic(field);
  return f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}[]`);
}

export function explainTargetErrors(
  errors: ErrorObject[],
  plan: SavedOutboundPlan,
  targetName: string,
): ExplainedTargetError[] {
  return errors.map((e) => {
    const missing = e.keyword === "required" ? (e.params as { missingProperty?: string }).missingProperty : undefined;
    const failingPath = missing ? `${e.instancePath}/${missing}` : e.instancePath;

    // Prefer the mapping that fills exactly this field; else any mapping inside it.
    const mapping =
      plan.mappings.find((m) => generic(m.targetField) === generic(failingPath)) ??
      plan.mappings.find((m) => covers(failingPath, m.targetField));
    const parameter = Object.values(plan.parameters ?? {}).find((p) => p.header && covers(failingPath, p.targetField));
    const canonicalField = mapping?.sourceField;
    const header = parameter?.header;

    if (!canonicalField && !header) {
      return { instancePath: e.instancePath, message: `${targetName}: ${failingPath || "(root)"} ${e.message ?? "is invalid"}` };
    }

    const what = canonicalField ? `the ${describeCanonicalField(canonicalField)} (${canonicalField})` : failingPath;
    const fix = [canonicalField ? "add it to the request" : undefined, header ? `send the ${header} header` : undefined]
      .filter(Boolean)
      .join(", or ");
    const message = missing
      ? `${targetName} requires ${what}. To fix: ${fix}.`
      : `${targetName} rejects ${what}: ${e.message ?? "invalid value"}. To fix: correct it in the request${header ? ` or send the ${header} header` : ""}.`;

    return {
      instancePath: e.instancePath,
      message,
      ...(canonicalField ? { canonicalField } : {}),
      ...(header ? { header } : {}),
    };
  });
}
