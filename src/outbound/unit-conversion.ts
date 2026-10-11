/**
 * Unit conversion for outbound targets.
 *
 * A target system only takes some units (DHL: kg and lb, cm and in). The saved plan says
 * which units the target accepts and what to turn the others into. This runs on the
 * canonical payload before the plan's mappings, because a weight's value and unit have
 * to change together and a field mapping only ever sees one of them.
 *
 * It lives under src/outbound on purpose. The inbound mapping engine does no computation;
 * a target's unit rules belong to the target.
 */

export type UnitKind = "weight" | "dimension";

export interface UnitRule {
  /** Canonical units the target takes as they are */
  accepted: string[];
  /** Canonical unit -> the accepted unit to convert it to, e.g. { "oz": "lb" } */
  convert?: Record<string, string>;
}

export type UnitPolicy = Partial<Record<UnitKind, UnitRule>>;

export interface UnitConversion {
  /** Where in the canonical payload the quantity was, e.g. /packages/0/weight */
  path: string;
  kind: UnitKind;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

/**
 * Units grouped by measuring system, each given as a whole number of the group's
 * smallest unit. Conversion is only allowed inside one group (oz <-> lb, g <-> kg,
 * cm <-> m), so every factor is exact and there is no metric/imperial drift.
 */
const UNIT_GROUPS: Record<UnitKind, Array<Record<string, number>>> = {
  weight: [
    { oz: 1, lb: 16 },
    { g: 1, kg: 1000 },
  ],
  dimension: [{ cm: 1, m: 100 }, { in: 1 }],
};

const DIMENSION_FIELDS = ["length", "width", "height"] as const;

/** Canonical object key that holds each kind of quantity */
const KIND_BY_KEY: Record<string, UnitKind> = { weight: "weight", dimensions: "dimension" };

function groupOf(kind: UnitKind, unit: string): Record<string, number> | undefined {
  return UNIT_GROUPS[kind].find((group) => unit in group);
}

/**
 * Three decimals, never rounded down: a carrier bills on the declared figure, so the
 * converted one must not come out smaller than the original. The toFixed pass removes
 * floating-point noise first, so an exact 2.5 does not become 2.501.
 */
export function roundUp3(value: number): number {
  return Math.ceil(Number((value * 1000).toFixed(6))) / 1000;
}

export function convertUnitValue(kind: UnitKind, value: number, from: string, to: string): number {
  const group = groupOf(kind, from);
  if (!group || !(to in group)) {
    throw new Error(`Cannot convert ${kind} from ${from} to ${to}`);
  }
  return roundUp3((value * group[from]!) / group[to]!);
}

/** Throws when a plan's unit policy asks for something the table cannot do exactly. */
export function assertUnitPolicy(policy: UnitPolicy | undefined): void {
  for (const [kind, rule] of Object.entries(policy ?? {}) as Array<[UnitKind, UnitRule]>) {
    if (!(kind in UNIT_GROUPS)) {
      throw new Error(`Unknown unit kind "${kind}" (known: ${Object.keys(UNIT_GROUPS).join(", ")})`);
    }
    if (!Array.isArray(rule.accepted) || rule.accepted.length === 0) {
      throw new Error(`Unit policy for ${kind} needs a non-empty "accepted" list`);
    }
    for (const unit of rule.accepted) {
      if (!groupOf(kind, unit)) {
        throw new Error(`Unit policy for ${kind} accepts unknown unit "${unit}"`);
      }
    }
    for (const [from, to] of Object.entries(rule.convert ?? {})) {
      const group = groupOf(kind, from);
      if (!group) {
        throw new Error(`Unit policy for ${kind} converts unknown unit "${from}"`);
      }
      if (rule.accepted.includes(from)) {
        throw new Error(`Unit policy for ${kind} both accepts and converts "${from}"`);
      }
      if (!rule.accepted.includes(to)) {
        throw new Error(`Unit policy for ${kind} converts ${from} to "${to}", which it does not accept`);
      }
      if (!(to in group)) {
        throw new Error(
          `Unit policy for ${kind} converts ${from} to ${to}: only conversions inside one measuring system are supported`,
        );
      }
    }
  }
}

/**
 * Returns a copy of the canonical payload with every weight and dimensions block the
 * target does not accept converted, plus a record of each change. The input is not
 * modified. A unit that is neither accepted nor convertible is left alone, so the target
 * schema check reports it.
 */
export function applyUnitPolicy<T>(
  payload: T,
  policy: UnitPolicy | undefined,
): { payload: T; conversions: UnitConversion[] } {
  const conversions: UnitConversion[] = [];
  if (!policy || Object.keys(policy).length === 0) {
    return { payload, conversions };
  }
  const copy = structuredClone(payload);
  walk(copy, "", policy, conversions);
  return { payload: copy, conversions };
}

function walk(node: unknown, path: string, policy: UnitPolicy, out: UnitConversion[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${path}/${index}`, policy, out));
    return;
  }
  if (!isPlainObject(node)) {
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    const childPath = `${path}/${key}`;
    const kind = KIND_BY_KEY[key];
    const rule = kind ? policy[kind] : undefined;
    if (kind && rule && isPlainObject(child) && typeof child.unit === "string") {
      convertQuantity(child, kind, rule, childPath, out);
    } else {
      walk(child, childPath, policy, out);
    }
  }
}

function convertQuantity(
  quantity: Record<string, unknown>,
  kind: UnitKind,
  rule: UnitRule,
  path: string,
  out: UnitConversion[],
): void {
  const from = quantity.unit as string;
  const to = rule.convert?.[from];
  if (rule.accepted.includes(from) || !to) {
    return;
  }

  const fields = kind === "weight" ? ["value"] : DIMENSION_FIELDS.filter((f) => quantity[f] !== undefined && quantity[f] !== null);
  // All or nothing: a block with a non-numeric figure is left exactly as it was.
  if (fields.length === 0 || fields.some((f) => typeof quantity[f] !== "number" || !Number.isFinite(quantity[f]))) {
    return;
  }

  const before = { ...quantity };
  for (const field of fields) {
    quantity[field] = convertUnitValue(kind, quantity[field] as number, from, to);
  }
  quantity.unit = to;
  out.push({ path, kind, from: before, to: { ...quantity } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
