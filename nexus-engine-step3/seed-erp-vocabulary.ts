// ERP (SAP) seed vocabulary.
//
// These are the known, finite fields behind the ERP `valid:false` packages failure. Because
// they're known, you don't need the suggest/accept loop to close the ERP cost leak — you can
// seed them directly and they'll resolve from customVocabulary at confidence 1.0 immediately.
// The suggest/accept machinery earns its keep on clients whose fields you DON'T know up front.
//
// SAP field meanings:
//   NTGEW = Nettogewicht (net weight)        -> packages.weight
//   GEWEI = Gewichtseinheit (weight unit)    -> packages.weightUnit
//   LFIMG = Liefermenge (delivery quantity)  -> packages.quantity
//   ARKTX = item short text                  -> packages.itemDescription
//   MATNR = Materialnummer (material number) -> packages.materialNumber

import type { VocabularyEntry } from "./types.js";

export const ERP_SEED: VocabularyEntry[] = [
  { inputField: "NTGEW", canonicalField: "packages.weight" },
  { inputField: "GEWEI", canonicalField: "packages.weightUnit" },
  { inputField: "LFIMG", canonicalField: "packages.quantity" },
  { inputField: "ARKTX", canonicalField: "packages.itemDescription" },
  { inputField: "MATNR", canonicalField: "packages.materialNumber" },
];
