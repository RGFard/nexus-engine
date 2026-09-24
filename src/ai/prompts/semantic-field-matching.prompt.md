# Semantic Field Matching

Match source fields to target fields using semantic similarity, not only lexical overlap.

## Scoring guidance

- **High confidence (0.85–1.0):** Same meaning and compatible types; strong description alignment.
- **Medium (0.6–0.84):** Clear synonym or nested path equivalence; may need light transform.
- **Low (0.4–0.59):** Plausible but ambiguous; document reasoning.
- **Below 0.4:** Do not map; list as unmapped.

## Special cases

| Pattern | Guidance |
|---------|----------|
| Nested objects | Map leaf paths; parent object may decompose into multiple mappings |
| Arrays | Map `/items[]/field` to `/packages[]/field` when cardinality aligns |
| Aliases | `street`/`line1`, `zip`/`postalCode`, `tracking`/`trackingNumber` |
| Extensions | Map carrier extras to `/extensions/{key}` or target `extensions` bucket |
| Metadata | `correlationId`, `sourceSystem`, timestamps map to shared metadata blocks |

## Pre-computed candidates

Use the supplied candidate pairs as hints; you may override when semantics clearly differ.
