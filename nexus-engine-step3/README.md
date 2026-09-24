# nexus-engine — Step 3: auto-learning vocabulary

Closes the loop where unmapped fields pay AI cost on every request. Once a field mapping is
learned for a client, it resolves from `customVocabulary` at confidence `1.0` and never hits
the AI path again. Vocabulary is isolated per client/tenant.

## Build order (as implemented)

1. **Priority resolution + store** — `resolver.ts`, `custom-vocabulary-store.ts`, `heuristic.ts`.
   The piece that delivers the cost win. `customVocabulary[clientId]` > built-in heuristic >
   unresolved. Validatable on its own by seeding the known ERP fields (`seed-erp-vocabulary.ts`).
2. **`suggestedMappings`** — `suggestions.ts`. Read-only; surfaces unmapped/low-confidence
   fields with a best-guess canonical target. No persistence.
3. **`POST /vocabulary/accept`** — `vocabulary-accept-route.ts`. Persists accepted mappings
   into the per-client store. Automates what seeding did by hand, for clients whose fields
   aren't known in advance.

## Why ERP gets seeded, not auto-suggested

SAP codes (NTGEW, LFIMG, MATNR, ARKTX, GEWEI) don't resemble canonical English field names,
so name-similarity can't guess them (the demo shows several at 0–44%). They're a known, finite
set, so seed them via `ERP_SEED` (or accept them once) and they resolve at confidence 1.0
immediately. Auto-suggestion earns its keep on clients whose fields you *don't* know up front.

## Run the proof

```
npm install
npm run demo
```

Shows 5/5 ERP fields paying AI cold → 0/5 after accept, a bogus canonical target rejected,
and a second tenant correctly seeing zero learned mappings.

## Integration points (marked `INTEGRATION POINT` in source)

- `canonical-schema.ts` — replace the hand-written set with a derivation from nexus-engine's
  real canonical schema. Only contract used is `isCanonicalField()`.
- `custom-vocabulary-store.ts` — swap `JsonFileVocabularyStore` for your real persistence
  (Postgres/Redis). Keep the `CustomVocabularyStore` interface; isolation is structural
  (per-client key, no list-all method).
- `resolver.ts` — consult `resolveFields()` in the existing mapping/plan step; only
  `unresolved` entries should reach AI fallback.
- `vocabulary-accept-route.ts` — mount `expressAcceptHandler` at `POST /vocabulary/accept`,
  or call `acceptVocabulary()` from your router.

## Design guarantees

- Validates the canonical **target** only; input field names stay arbitrary by design.
- Per-client isolation is enforced structurally, not by convention.
- Zero runtime dependencies (`tsx`/`typescript`/`@types/node` are dev-only).
