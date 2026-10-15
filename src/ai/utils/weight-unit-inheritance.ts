/**
 * Some carriers send the shipment total weight as a bare number (FedEx `totalWeight`)
 * while each package weight carries its unit. When canonical `/weight` has a value but
 * no unit, take the unit from the package weights, as long as they all agree.
 * Returns the unit that was filled in, or undefined when nothing changed.
 */
export function inheritTotalWeightUnit(payload: Record<string, unknown>): string | undefined {
  const weight = payload.weight;
  if (!isObject(weight) || weight.value === undefined || weight.value === null) return undefined;
  if (typeof weight.unit === "string" && weight.unit.length > 0) return undefined;

  const packages = Array.isArray(payload.packages) ? payload.packages : [];
  const units = new Set<string>();
  for (const pkg of packages) {
    if (isObject(pkg) && isObject(pkg.weight) && typeof pkg.weight.unit === "string") {
      units.add(pkg.weight.unit);
    }
  }
  if (units.size !== 1) return undefined;

  const [unit] = units;
  weight.unit = unit;
  return unit;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
