// Canonical schema registry.
//
// INTEGRATION POINT: replace this hand-written set with a derivation from nexus-engine's
// real canonical schema (e.g. walk the Zod/JSON schema and collect leaf paths). The only
// contract Step 3 relies on is `isCanonicalField()` — a field is a valid *target* for a
// learned mapping iff it exists here.
//
// Note: this validates the canonical *target* (the destination), never the input side.
// Input field names are arbitrary by design — refusing unknown inputs would defeat the
// purpose of the whole system. We only guard against learning a mapping that points at a
// canonical field that doesn't exist.

export const CANONICAL_FIELDS: ReadonlySet<string> = new Set<string>([
  // origin
  "origin.name",
  "origin.streetLines",
  "origin.city",
  "origin.postalCode",
  "origin.countryCode",
  // destination
  "destination.name",
  "destination.streetLines",
  "destination.city",
  "destination.postalCode",
  "destination.countryCode",
  // contact
  "contact.name",
  "contact.phone",
  "contact.email",
  // packages (the ERP gap lives here)
  "packages.weight",
  "packages.weightUnit",
  "packages.quantity",
  "packages.itemDescription",
  "packages.materialNumber",
  // top-level
  "trackingNumber",
  "orderNumber",
  // customs / international
  "customs.commodityDescription",
  "customs.value",
  "customs.currency",
]);

export function isCanonicalField(field: string): boolean {
  return CANONICAL_FIELDS.has(field);
}
