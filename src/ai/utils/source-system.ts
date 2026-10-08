/**
 * Best-guess label for which carrier/ERP schema an incoming payload matches,
 * based on the naming conventions we've seen across the fixtures tested so far
 * (SAP/ERP, DHL, FedEx, UPS, ShipStation). The caller never states a carrier,
 * so this looks at every field path discovered in the payload (the same list
 * already built for mapping) and checks it against each known schema's
 * distinctive naming. One call per request, not per field: whichever system's
 * pattern matches first (in priority order below) is the whole payload's
 * answer.
 */

interface SourceSystemPattern {
  system: string;
  test: (path: string) => boolean;
}

// Order matters: more distinctive patterns first, so a path that happens to
// match a generic pattern lower down gets claimed by the specific one above it.
const PATTERNS: SourceSystemPattern[] = [
  {
    system: "SAP/ERP",
    // SAP's flat format: a single all-caps segment, digits/underscores allowed
    // (NAME1_E, PSTLZ_E, VBELN, BSTNK, ERDAT, KUNNR, BRGEW, VSART_BEZ, INCO1...).
    test: (p) => /^\/[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(p),
  },
  {
    system: "DHL",
    test: (p) =>
      /\/(Shipper|Recipient|InternationalDetail|ShipmentInfo|PickupDetails)\//.test(p) ||
      p.includes("/RequestedPackages") ||
      /^\/(ShipmentCreationDate|DeclaredValueCurrecyCode)$/.test(p),
  },
  {
    system: "FedEx",
    test: (p) =>
      p.includes("/requestedPackageLineItems") || p.includes("/output/transactionShipments"),
  },
  {
    system: "UPS",
    test: (p) =>
      p.startsWith("/ShipmentIdentificationNumber") ||
      p.includes("/ShipFrom/Address/") ||
      p.includes("/Package[]/Dimensions/UnitOfMeasurement"),
  },
  {
    system: "ShipStation",
    test: (p) =>
      p.includes("/advancedOptions/") ||
      p.startsWith("/orderNumber") ||
      p.startsWith("/orderId") ||
      p.startsWith("/customerEmail") ||
      p.startsWith("/from_address/") ||
      p.startsWith("/shipTo/") ||
      p.startsWith("/dimensions/units"),
  },
];

export function detectSourceSystem(fieldPaths: Iterable<string>): string | null {
  for (const pattern of PATTERNS) {
    for (const path of fieldPaths) {
      if (pattern.test(path)) {
        return pattern.system;
      }
    }
  }
  return null;
}
