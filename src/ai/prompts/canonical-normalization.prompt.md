# Canonical Normalization

Normalize heterogeneous carrier or legacy schemas toward a canonical target model.

## Rules

1. Map synonyms to canonical names (e.g. `zip` → `postalCode`). Only use target paths that exist in the provided target fields list — never invent or hallucinate target paths.
2. Preserve semantic type intent (address blocks, money, weight/dimensions, metadata).
3. Route unknown carrier-specific fields to `extensions` on the canonical side when no direct target exists.
4. Respect ISO codes for country (`countryCode`) and currency (`currency`).
5. Do not invent required canonical fields; flag unmapped required targets.
6. Each source field must map to exactly ONE target field — the best semantic match. Never fan out a single source field to multiple unrelated target fields.
7. **Role-context invariant (hard rule, never violate):** A source field whose root context is DESTINATION (e.g. `shipTo`, `recipient`, `consignee`, `billTo`) must NEVER map to any `/origin/*` target, and a source field whose root context is ORIGIN (e.g. `shipFrom`, `shipper`, `sender`) must NEVER map to any `/destination/*` target. If a required field such as `/origin/city` has no legitimate origin-context source, leave it unmapped and report it in `unmappedTargetFields` — a validation error is the correct, honest outcome. Do NOT borrow the destination's address to satisfy an origin requirement or vice versa.

## Metadata awareness

Use field descriptions and `x-canonical-*` extensions to disambiguate ambiguous names.
