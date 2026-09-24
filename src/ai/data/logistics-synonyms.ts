/**
 * Logistics domain semantic concepts for carrier ↔ canonical field matching.
 * Concepts group synonymous names by meaning, not lexical equality.
 */

export interface LogisticsConcept {
  /** Stable semantic identifier */
  id: string;
  /** Human-readable meaning for reasoning strings */
  label: string;
  /** Normalized name tokens that map to this concept */
  synonyms: string[];
  /** Canonical target path patterns (suffix or full path) */
  canonicalPaths: string[];
  /** Parent context hints (origin, destination, package, carrier, etc.) */
  contexts?: string[];
}

/** Normalize for synonym lookup */
export function normalizeToken(value: string): string {
  return value
    .replace(/\[\]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export const LOGISTICS_CONCEPTS: LogisticsConcept[] = [
  {
    id: "tracking_number",
    label: "primary carrier tracking identifier",
    synonyms: [
      "trackingnumber",
      "trackingno",
      "trackingid",
      "tracking",
      "mastertrackingnumber",
      "mastertrackingno",
      "shipmentidentificationnumber",
      "shipmenttrackingnumber",
      "shipmenttrackingno",
      "waybillnumber",
      "waybill",
      "pronumber",
      "trackingids",
      "trackid",
    ],
    canonicalPaths: ["/trackingNumber", "/identifiers/masterTrackingNumber", "/trackingNumbers"],
    contexts: ["shipment", "tracking"],
  },
  {
    id: "shipment_id",
    label: "shipment or consignment identifier",
    synonyms: [
      "shipmentid",
      "shipment_id",
      "consignmentnumber",
      "consignmentno",
      "jobid",
      "shipmentno",
    ],
    canonicalPaths: ["/shipmentId", "/identifiers/shipmentId", "/identifiers/externalId"],
  },
  {
    id: "estimated_delivery",
    label: "estimated delivery date or time",
    synonyms: [
      "estimateddelivery",
      "estimateddeliverydate",
      "estimateddeliverytimestamp",
      "estimateddeliverywindow",
      "deliverydate",
      "expecteddeliverydate",
      "promiseddeliverydate",
      "scheduleddeliverydate",
      "committeddeliverydate",
      "edd",
    ],
    canonicalPaths: [
      "/estimatedDelivery/date",
      "/estimatedDelivery/dateTime",
      "/estimatedDeliveryDate",
    ],
    contexts: ["delivery"],
  },
  {
    id: "package_weight",
    label: "package or shipment weight",
    synonyms: [
      "weight",
      "packageweight",
      "weightkg",
      "weightlb",
      "totalweight",
      "shipmentweight",
      "billingweight",
      "actualweight",
      "dimweight",
      // SAP/ERP: NTGEW = net weight (primary), BRGEW = gross weight (fallback)
      "ntgew",
      "brgew",
    ],
    canonicalPaths: [
      "/packages[]/weight/value",
      "/packages[]/weight",
    ],
    contexts: ["package"],
  },
  {
    id: "origin_postal",
    label: "ship-from postal or ZIP code",
    synonyms: [
      "postalcode",
      "zipcode",
      "zip",
      "postcode",
      "shipperpostalcode",
      "senderpostalcode",
      "frompostalcode",
      "originpostalcode",
    ],
    contexts: ["origin", "shipper", "sender", "shipfrom"],
    canonicalPaths: ["/origin/postalCode"],
  },
  {
    id: "destination_postal",
    label: "ship-to postal or ZIP code",
    synonyms: [
      "postalcode",
      "zipcode",
      "zip",
      "postcode",
      "consigneepostalcode",
      "recipientpostalcode",
      "topostalcode",
      "destinationpostalcode",
      "deliverpostalcode",
    ],
    canonicalPaths: ["/destination/postalCode"],
    contexts: ["destination", "consignee", "recipient", "shipto"],
  },
  {
    id: "origin_line1",
    label: "ship-from street address line",
    synonyms: [
      "line1",
      "addressline1",
      "street",
      "street1",
      "shipperstreet",
      "senderstreet",
      "fromaddress",
      "originaddress",
      "shipfromaddress",
    ],
    canonicalPaths: ["/origin/line1"],
    contexts: ["origin", "shipper", "sender"],
  },
  {
    id: "destination_line1",
    label: "ship-to street address line",
    synonyms: [
      "consigneeaddress",
      "recipientstreet",
      "tostreet",
      "shiptoaddress",
      "deliveryaddress",
      "destinationaddress",
      "line1",
      "addressline1",
      "street",
      "street1",
      "shipperstreet",
      "senderstreet",
      "fromaddress",
      "originaddress",
      "shipfromaddress",
      "addressline",
      "streetaddress",
      "streetline1",
      "streetline",
      "address1",
      "addr1",
      "deliverystreet",
      "recipientaddress",
    ],
    canonicalPaths: ["/destination/line1"],
    contexts: ["destination", "consignee", "recipient"],
  },
  {
    id: "origin_city",
    label: "ship-from city",
    synonyms: ["shippercity", "sendercity", "fromcity", "origincity", "city", "cityname", "town", "township", "municipality", "locality"],
    canonicalPaths: ["/origin/city"],
    contexts: ["origin", "shipper", "sender"],
  },
  {
    id: "destination_city",
    label: "ship-to city",
    synonyms: ["consigneecity", "recipientcity", "tocity", "destinationcity", "city", "cityname", "town", "township", "municipality", "locality"],
    canonicalPaths: ["/destination/city"],
    contexts: ["destination", "consignee", "recipient"],
  },
  {
    id: "origin_country",
    label: "ship-from country code",
    synonyms: ["shippercountry", "sendercountry", "fromcountry", "origincountry", "countrycode", "country", "countryname", "nation"],
    canonicalPaths: ["/origin/countryCode"],
    contexts: ["origin", "shipper", "sender"],
  },
  {
    id: "destination_country",
    label: "ship-to country code",
    synonyms: ["consigneecountry", "recipientcountry", "tocountry", "destinationcountry", "countrycode", "country", "countryname", "nation"],
    canonicalPaths: ["/destination/countryCode"],
    contexts: ["destination", "consignee", "recipient"],
  },
  {
    id: "carrier_code",
    label: "carrier or operator code",
    synonyms: ["carriercode", "carrier", "carrierid", "scac", "operatorcode", "servicetype"],
    canonicalPaths: ["/carrier/carrierCode", "/carrier/carrierName"],
    contexts: ["carrier"],
  },
  {
    id: "service_level",
    label: "shipping service level or product",
    synonyms: [
      "servicelevel",
      "servicecode",
      "servicetype",
      "shipmethod",
      "productcode",
      "service",
      "deliveryservice",
    ],
    canonicalPaths: ["/serviceLevel", "/carrier/serviceCode"],
  },
  {
    id: "package_dimensions",
    label: "package dimensions",
    synonyms: ["dimensions", "length", "width", "height", "packagedimensions"],
    canonicalPaths: ["/packages[]/dimensions", "/dimensions"],
    contexts: ["package"],
  },
  {
    id: "label_url",
    label: "shipping label URL or document",
    synonyms: ["labelurl", "label", "shippinglabel", "labelpdf"],
    canonicalPaths: ["/labels[]/url", "/labelUrl"],
  },
  {
    id: "correlation_id",
    label: "request correlation or trace identifier",
    synonyms: ["correlationid", "requestid", "traceid", "transactionid"],
    canonicalPaths: ["/metadata/correlationId"],
  },
  {
    id: "state_province",
    label: "state, province, or administrative region",
    synonyms: [
      "state",
      "province",
      "stateprovince",
      "stateorprovince",
      "stateprovinceode",
      "statecode",
      "provincecode",
      "region",
      "regioncode",
      "county",
      "territory",
      "administrativearea",
      "adminarea",
      "admindistrict",
      "district",
      "prefecture",
    ],
    canonicalPaths: ["/origin/stateOrProvince", "/destination/stateOrProvince"],
    contexts: ["origin", "destination"],
  },
  {
    id: "weight_unit",
    label: "weight unit of measure",
    synonyms: [
      "weightunit", "weightunitofmeasure", "uomweight", "wtuom",
      "gewei", // SAP: GEWEI
    ],
    canonicalPaths: ["/packages[]/weight/unit", "/weight/unit"],
    contexts: ["package"],
  },
  {
    id: "package_quantity",
    label: "package or delivery quantity",
    synonyms: [
      "quantity", "qty", "piececount", "itemcount", "numberofpieces",
      "lfimg", // SAP: LFIMG (Liefermenge = delivery quantity)
    ],
    canonicalPaths: ["/packages[]/quantity"],
    contexts: ["package"],
  },
  {
    id: "package_sku",
    label: "package material number, SKU, or product code",
    synonyms: [
      "sku", "materialnumber", "productcode", "itemcode", "partnumber", "articlecode",
      "matnr", // SAP: MATNR (Materialnummer)
    ],
    canonicalPaths: ["/packages[]/sku"],
    contexts: ["package"],
  },
  {
    id: "package_description",
    label: "package contents or article description",
    synonyms: [
      "description", "itemdescription", "contentsdescription", "goodsdescription",
      "arktx", // SAP: ARKTX (Artikelkurztext = article short text)
    ],
    canonicalPaths: ["/packages[]/description"],
    contexts: ["package"],
  },
];

/** Explicit source→target path mappings for high-confidence logistics pairs */
export const EXPLICIT_PATH_MAPPINGS: Array<{
  sourcePattern: RegExp;
  targetPath: string;
  /** When present, overrides the loose endsWith check — only fires when targetPath matches exactly */
  targetPattern?: RegExp;
  reasoning: string;
}> = [
  {
    sourcePattern: /estimatedDeliveryTimestamp$/i,
    targetPath: "/estimatedDelivery/dateTime",
    reasoning: "Estimated delivery timestamp maps to canonical estimated delivery date-time.",
  },
  {
    sourcePattern: /deliveryDate$/i,
    targetPath: "/estimatedDelivery/date",
    reasoning: "Delivery date represents the estimated delivery calendar date.",
  },
  {
    sourcePattern: /PackageWeight\/Weight$/i,
    targetPath: "/packages[]/weight/value",
    reasoning: "Package weight numeric value maps to canonical weight value.",
  },
  {
    sourcePattern: /PackageWeight\/UnitOfMeasurement\/Code$/i,
    targetPath: "/packages[]/weight/unit",
    reasoning: "Package weight unit code maps to canonical weight unit.",
  },
  {
    sourcePattern: /consigneePostalCode$/i,
    targetPath: "/destination/postalCode",
    reasoning: "Consignee postal code is the destination postal code.",
  },
  {
    sourcePattern: /shipperPostalCode$/i,
    targetPath: "/origin/postalCode",
    reasoning: "Shipper postal code is the origin postal code.",
  },
  {
    sourcePattern: /PackagingType\/Code$/i,
    targetPath: "/extensions/packagingTypeCode",
    reasoning: "UPS packaging type code is carrier-specific; route to extensions.",
  },
  {
    // Matches full path /weight/value — routes top-level shipment weight to the first package.
    // targetPattern prevents the generic endsWith("value") check from also matching /weight/value.
    sourcePattern: /^\/weight\/value$/,
    targetPath: "/packages[]/weight/value",
    targetPattern: /^\/packages(?:\[\])?\/weight\/value$/,
    reasoning: "Top-level shipment weight value maps to the first package's weight value.",
  },
  {
    // Handles plural "units" field (ShipStation, ShipBob, etc.) as well as singular "unit".
    sourcePattern: /^\/weight\/units?$/,
    targetPath: "/packages[]/weight/unit",
    targetPattern: /^\/packages(?:\[\])?\/weight\/unit$/,
    reasoning: "Top-level weight unit/units maps to the canonical package weight unit.",
  },
  // ── SAP/ERP flat-format field mappings ────────────────────────────────────
  {
    // NTGEW (Nettogewicht) — net weight value; primary weight source.
    // BRGEW (Bruttogewicht, gross weight) is intentionally absent here: it maps
    // via the package_weight semantic concept at lower confidence, so it only
    // wins when NTGEW is not present in the payload.
    sourcePattern: /^NTGEW$/i,
    targetPath: "/packages[]/weight/value",
    targetPattern: /^\/packages(?:\[\])?\/weight\/value$/,
    reasoning: "SAP NTGEW (net weight) maps to the canonical package weight value.",
  },
  {
    // GEWEI (Gewichtseinheit) — weight unit; inferTransformation will apply
    // cast:string|normalize:weightUnit because the target ends with /weight/unit.
    sourcePattern: /^GEWEI$/i,
    targetPath: "/packages[]/weight/unit",
    targetPattern: /^\/packages(?:\[\])?\/weight\/unit$/,
    reasoning: "SAP GEWEI (weight unit) maps to the canonical package weight unit.",
  },
  {
    // LFIMG (Liefermenge) — delivery quantity.
    sourcePattern: /^LFIMG$/i,
    targetPath: "/packages[]/quantity",
    targetPattern: /^\/packages(?:\[\])?\/quantity$/,
    reasoning: "SAP LFIMG (delivery quantity) maps to the canonical package quantity.",
  },
  {
    // MATNR (Materialnummer) — material number / SKU.
    sourcePattern: /^MATNR$/i,
    targetPath: "/packages[]/sku",
    targetPattern: /^\/packages(?:\[\])?\/sku$/,
    reasoning: "SAP MATNR (material number) maps to the canonical package SKU.",
  },
  {
    // ARKTX (Artikelkurztext) — article short text / description.
    sourcePattern: /^ARKTX$/i,
    targetPath: "/packages[]/description",
    targetPattern: /^\/packages(?:\[\])?\/description$/,
    reasoning: "SAP ARKTX (article short text) maps to the canonical package description.",
  },
  // ── SAP address fields ────────────────────────────────────────────────────
  // _S suffix = Sender (ship-from/origin); _E suffix = Empfänger (ship-to/destination).
  // countryCode targets get cast:string|normalize:countryCode via inferTransformation.
  {
    sourcePattern: /^STRAS_S$/i,
    targetPath: "/origin/line1",
    targetPattern: /^\/origin\/line1$/,
    reasoning: "SAP STRAS_S (Straße Sender — sender street) maps to the canonical origin address line 1.",
  },
  {
    sourcePattern: /^ORT01_S$/i,
    targetPath: "/origin/city",
    targetPattern: /^\/origin\/city$/,
    reasoning: "SAP ORT01_S (Ort Sender — sender city) maps to the canonical origin city.",
  },
  {
    sourcePattern: /^LAND1_S$/i,
    targetPath: "/origin/countryCode",
    targetPattern: /^\/origin\/countryCode$/,
    reasoning: "SAP LAND1_S (Land Sender — sender country) maps to the canonical origin country code.",
  },
  {
    sourcePattern: /^STRAS_E$/i,
    targetPath: "/destination/line1",
    targetPattern: /^\/destination\/line1$/,
    reasoning: "SAP STRAS_E (Straße Empfänger — recipient street) maps to the canonical destination address line 1.",
  },
  {
    sourcePattern: /^ORT01_E$/i,
    targetPath: "/destination/city",
    targetPattern: /^\/destination\/city$/,
    reasoning: "SAP ORT01_E (Ort Empfänger — recipient city) maps to the canonical destination city.",
  },
  {
    sourcePattern: /^LAND1_E$/i,
    targetPath: "/destination/countryCode",
    targetPattern: /^\/destination\/countryCode$/,
    reasoning: "SAP LAND1_E (Land Empfänger — recipient country) maps to the canonical destination country code.",
  },
];

/** Parent path context keywords */
export const CONTEXT_KEYWORDS: Record<string, RegExp[]> = {
  origin: [/origin/i, /shipper/i, /sender/i, /shipfrom/i, /from/i],
  // (?<!bill) excludes "billTo" from matching as destination — billTo is billing, not ship-to
  destination: [/destination/i, /consignee/i, /recipient/i, /shipto/i, /(?<!bill)to/i, /deliver/i],
  billing: [/billto/i, /billing/i, /invoice/i, /payer/i],
  package: [/package/i, /parcel/i, /piece/i, /item/i],
  carrier: [/carrier/i, /operator/i, /fedex/i, /ups/i, /dhl/i],
};
