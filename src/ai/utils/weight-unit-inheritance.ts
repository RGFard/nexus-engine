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

const SYSTEM_UNITS: Record<string, { weight: string; dimension: string }> = {
  metric: { weight: "kg", dimension: "cm" },
  imperial: { weight: "lb", dimension: "in" },
};

/**
 * Some carriers send bare numbers for weights and dimensions and name the unit system
 * once for the whole shipment (DHL MyDHL: unitOfMeasurement "metric"). The mapper keeps
 * that as extensions.unitSystem (and extensions.dimensionUnitSystem when dimensions use
 * another system). Every weight or dimensions block that has values but no unit gets
 * kg/lb or cm/in from it. Blocks with a unit are left alone. Returns how many were filled.
 */
export function fillUnitsFromSystem(payload: Record<string, unknown>): number {
  const ext = isObject(payload.extensions) ? payload.extensions : {};
  const weightSystem = SYSTEM_UNITS[String(ext.unitSystem ?? "").toLowerCase()];
  const dimensionSystem = SYSTEM_UNITS[String(ext.dimensionUnitSystem ?? ext.unitSystem ?? "").toLowerCase()];
  if (!weightSystem && !dimensionSystem) return 0;

  let filled = 0;
  const visit = (node: unknown, key: string | undefined): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, undefined));
      return;
    }
    if (!isObject(node)) return;
    const noUnit = typeof node.unit !== "string" || node.unit.length === 0;
    if (key === "weight" && weightSystem && noUnit && node.value !== undefined && node.value !== null) {
      node.unit = weightSystem.weight;
      filled += 1;
    } else if (key === "dimensions" && dimensionSystem && noUnit && ["length", "width", "height"].some((f) => node[f] !== undefined)) {
      node.unit = dimensionSystem.dimension;
      filled += 1;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k !== "extensions") visit(v, k);
    }
  };
  visit(payload, undefined);
  return filled;
}
