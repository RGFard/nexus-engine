# Semantic Field Matching

Match source fields to target fields using semantic similarity, not only lexical overlap.

## Scoring guidance

- **High confidence (0.85–1.0):** Same meaning and compatible types; strong description alignment.
- **Medium (0.6–0.84):** Clear synonym or nested path equivalence; may need light transform.
- **Low (0.4–0.59):** A genuine, if uncertain, semantic fit — you believe it plausibly belongs at that
  target, you're just not fully sure. Map it and document the uncertainty in the reasoning.
- **Below 0.4:** Do not map; list as unmapped.

**Low confidence is not the same as "no fit."** If a field has no genuine semantic fit for any
canonical target — the schema happens to have a path with a similar-sounding name, or a
pre-computed candidate suggested one, but the meaning doesn't actually match (e.g. a volume unit
against a dimension-unit target) — do not map it there regardless of what score you'd attach. A
structurally valid target path existing in the schema does not make it the correct one. In that
case either target `/extensions/{key}` (see below) or omit it and list it in `unmappedSourceFields`.
If your own reasoning would say a mapping is wrong, doesn't belong, or should really go to
extensions — act on that and change the `targetField` accordingly. Never submit a target you
believe is incorrect and only note the doubt in the reasoning text; nothing downstream reads it.

## Special cases

| Pattern | Guidance |
|---------|----------|
| Nested objects | Map leaf paths; parent object may decompose into multiple mappings |
| Arrays | Map `/items[]/field` to `/packages[]/field` when cardinality aligns |
| Aliases | `street`/`line1`, `zip`/`postalCode`, `tracking`/`trackingNumber` |
| Extensions | Map carrier extras — or any field with no genuine canonical fit — to `/extensions/{key}` |
| Metadata | `correlationId`, `sourceSystem`, timestamps map to shared metadata blocks |

## Pre-computed candidates

The supplied candidate pairs are a starting point, not an endorsement — they come from lexical/
structural similarity and can be wrong. If you don't believe a candidate's suggested target is
actually correct, don't propose it as-is: retarget it to `/extensions/{key}` or drop it, the same
as any other field with no genuine fit.
