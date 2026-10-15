export interface PathSegment {
  key: string;
  /** True when segment is `key[]` (array wildcard) */
  isArray: boolean;
  /** Set when segment is `key[N]` (explicit index access) */
  index?: number;
}

/** Parse JSON Pointer-style paths with `[]` array wildcards */
export function parsePath(pointer: string): PathSegment[] {
  const normalized = pointer.startsWith("/") ? pointer : `/${pointer}`;
  const parts = normalized.split("/").filter(Boolean);

  return parts.map((part) => {
    if (part.endsWith("[]")) {
      return { key: part.slice(0, -2), isArray: true };
    }
    const indexMatch = part.match(/^(.+)\[(\d+)\]$/);
    if (indexMatch) {
      return { key: indexMatch[1]!, isArray: false, index: parseInt(indexMatch[2]!, 10) };
    }
    return { key: part, isArray: false };
  });
}

export function getByPath(root: unknown, pointer: string): unknown {
  if (pointer.endsWith("[]")) {
    return getByPath(root, pointer.slice(0, -2));
  }
  const segments = parsePath(pointer);
  return getAtSegments(root, segments, 0);
}

/**
 * Resolves a source path for mapping onto a target path.
 * - Unwraps single-value arrays produced by `[]` wildcards when the target is scalar.
 * - Falls back to first array index (`/items/0/field`) when `[]` wildcard misses.
 */
export function resolveMappingSourceValue(
  root: unknown,
  sourcePointer: string,
  targetPointer: string,
): unknown {
  const targetHasArray = targetPointer.includes("[]");

  // A source nested in more arrays than its target (/shipments[]/packages[]/weight/value
  // onto /packages[]/weight/value) reads the first item of each extra outer array, so the
  // value lines up with the target's own array depth. A scalar target has depth 0, so it
  // gets item 0 throughout (what array:first means).
  let value = getByPath(root, collapseOuterWildcards(sourcePointer, countWildcards(targetPointer)));

  if (value === undefined) {
    if (sourcePointer.endsWith("[]")) {
      value = getByPath(root, sourcePointer.slice(0, -2));
    } else {
      const indexed = sourcePointer.replace(/([^/]+)\[\]/g, "$1/0");
      if (indexed !== sourcePointer) {
        value = getByPath(root, indexed);
      }
    }
  }

  let result: unknown;
  if (Array.isArray(value) && !targetHasArray) {
    result = value.length === 0 ? undefined : value;
  } else {
    result = value;
  }

  console.log("[resolveMappingSourceValue]", {
    sourcePointer,
    endsWithBrackets: sourcePointer.endsWith("[]"),
    result: Array.isArray(result) ? `Array(${result.length})` : result,
  });

  return result;
}

function countWildcards(pointer: string): number {
  return (pointer.match(/\[\]/g) ?? []).length;
}

/** Replaces outer `[]/` wildcards with `/0/` until at most `keep` item wildcards remain. */
function collapseOuterWildcards(pointer: string, keep: number): string {
  let extra = (pointer.match(/\[\]\//g) ?? []).length - keep;
  let out = pointer;
  while (extra > 0) {
    out = out.replace("[]/", "/0/");
    extra -= 1;
  }
  return out;
}

/** True when the pointer reads a field inside array items, e.g. `/packages[]/weight/value`. */
export function hasItemWildcard(pointer: string): boolean {
  return pointer.includes("[]/");
}

export function setByPath(root: unknown, pointer: string, value: unknown): unknown {
  const target = isPlainObject(root) || Array.isArray(root) ? root : {};
  const segments = parsePath(pointer);
  setAtSegments(target, segments, 0, value);
  return target;
}

function getAtSegments(current: unknown, segments: PathSegment[], index: number): unknown {
  if (index >= segments.length) {
    return current;
  }

  const segment = segments[index]!;
  const isLast = index === segments.length - 1;

  if (current === null || current === undefined) {
    return undefined;
  }

  if (segment.isArray) {
    // `key[]` names an array held under `key` on the current node, so look the key up
    // first. This branch used to test `current` itself, which is the parent object and
    // never the array, so every wildcard read returned undefined and callers fell back
    // to item 0: any package after the first was silently dropped.
    const list = isPlainObject(current) ? current[segment.key] : undefined;
    if (!Array.isArray(list)) {
      return undefined;
    }
    const childSegments = segments.slice(index + 1);
    if (childSegments.length === 0) {
      return list;
    }
    return list.map((item) => getAtSegments(item, childSegments, 0));
  }

  if (!isPlainObject(current) && !Array.isArray(current)) {
    return undefined;
  }

  const record = current as Record<string, unknown>;
  const next = record[segment.key];

  if (segment.index !== undefined) {
    if (!Array.isArray(next)) {
      return undefined;
    }
    const item = next[segment.index];
    if (isLast) {
      return item;
    }
    return getAtSegments(item, segments, index + 1);
  }

  if (isLast) {
    return next;
  }

  return getAtSegments(next, segments, index + 1);
}

function setAtSegments(
  current: unknown,
  segments: PathSegment[],
  index: number,
  value: unknown,
): void {
  if (index >= segments.length) {
    return;
  }

  const segment = segments[index]!;
  const isLast = index === segments.length - 1;

  if (segment.isArray) {
    if (!Array.isArray(current)) {
      const container = asObject(current);
      if (container[segment.key] === undefined || container[segment.key] === null) {
        container[segment.key] = [];
      }
      setAtSegments(container[segment.key], segments, index, value);
      return;
    }

    if (isLast) {
      if (!Array.isArray(value)) {
        throw new PathError(`Cannot assign non-array to array path ${segment.key}[]`);
      }
      current.length = 0;
      current.push(...value);
      return;
    }

    const childSegments = segments.slice(index + 1);
    // A scalar value at an array-notation target (e.g. a shipment-level currency
    // applied to every /customs/lineItems[]/unitValue/currency) broadcasts to every
    // existing item rather than only the first — it isn't itself a per-item array.
    const isBroadcastScalar = !Array.isArray(value);
    const values = isBroadcastScalar ? [value] : value;

    if (values.length > current.length) {
      while (current.length < values.length) {
        current.push({});
      }
    }

    const iterationLength = isBroadcastScalar ? current.length : values.length;
    for (let i = 0; i < iterationLength; i++) {
      const item = current[i];
      if (item === undefined || item === null) {
        current[i] = {};
      }
      // A per-item value that is missing for this item leaves the item alone, instead of
      // creating an empty parent object (e.g. `dimensions: {}`) that then fails validation.
      if (!isBroadcastScalar && values[i] === undefined) {
        continue;
      }
      setAtSegments(current[i], childSegments, 0, isBroadcastScalar ? values[0] : values[i]);
    }
    return;
  }

  const container = asObject(current);
  if (isLast) {
    container[segment.key] = value;
    return;
  }

  if (container[segment.key] === undefined || container[segment.key] === null) {
    // This segment isn't array-flagged itself (that case is handled above), so it's
    // always a plain object here — even when the *next* segment is a `[]` wildcard
    // (e.g. /customs/lineItems[]/hsCode: "customs" is a container object holding the
    // "lineItems" array, not an array itself). That next segment creates its own
    // array when its turn comes, via the isArray branch above.
    container[segment.key] = {};
  }

  setAtSegments(container[segment.key], segments, index + 1, value);
}

export function createEmptyTarget(initial?: unknown): Record<string, unknown> {
  if (isPlainObject(initial)) {
    return structuredClone(initial) as Record<string, unknown>;
  }
  return {};
}

export function pathDepth(pointer: string): number {
  return parsePath(pointer).length;
}

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(current: unknown): Record<string, unknown> {
  if (!isPlainObject(current)) {
    throw new PathError("Expected object at path segment");
  }
  return current;
}
