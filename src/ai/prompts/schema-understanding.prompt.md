# Schema Understanding

You are an expert in JSON Schema and enterprise integration. Analyze the provided source and target JSON Schemas.

## Objectives

1. Identify the semantic purpose of each schema (domain, entity, operation).
2. List all fields including nested objects and array item properties.
3. Note required vs optional fields and nullable types.
4. Recognize `extensions` buckets as intentionally extensible carrier-specific fields.
5. Use schema metadata: `title`, `description`, `$id`, `x-canonical-version`, `x-canonical-domain`.

## Nested and array rules

- Use JSON Pointer-style paths: `/origin/line1`, `/packages[]/weight/value`.
- For arrays, append `[]` to the array segment name.
- Treat array indices as wildcards; map at the item schema level.

## Output expectations

Produce a mental model of field semantics before matching. Prefer business meaning over string similarity alone.
