import { getByPath, setByPath } from "./json-path.js";

export interface CanonicalDefaultSpec {
  strategy: "constant" | "now" | "coalesce";
  value?: unknown;
  paths?: string[];
}

/** Apply top-level x-canonical-default hints from a JSON Schema onto a target payload. */
export function applyCanonicalDefaults(
  target: Record<string, unknown>,
  schema: Record<string, unknown>,
): string[] {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) {
    return [];
  }

  const applied: string[] = [];

  for (const [name, propSchema] of Object.entries(properties)) {
    const path = `/${name}`;
    const current = getByPath(target, path);
    if (current !== undefined && current !== null && current !== "") {
      continue;
    }

    const spec = propSchema["x-canonical-default"] as CanonicalDefaultSpec | undefined;
    if (!spec) {
      continue;
    }

    const value = resolveDefault(spec, target);
    if (value === undefined) {
      continue;
    }

    setByPath(target, path, value);
    applied.push(path);
  }

  return applied;
}

function resolveDefault(
  spec: CanonicalDefaultSpec,
  target: Record<string, unknown>,
): unknown {
  if (spec.strategy === "constant") {
    return spec.value;
  }

  if (spec.strategy === "now") {
    return new Date().toISOString();
  }

  if (spec.strategy === "coalesce") {
    for (const pointer of spec.paths ?? []) {
      const candidate = getByPath(target, pointer);
      if (candidate !== undefined && candidate !== null && candidate !== "") {
        return candidate;
      }
    }
  }

  return undefined;
}
