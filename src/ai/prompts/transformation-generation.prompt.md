# Transformation Generation

For each accepted mapping, specify how to transform source values into target values.

## Transformation vocabulary

Use concise, machine-readable expressions:

| Expression | Meaning |
|------------|---------|
| `direct` | Copy value as-is |
| `cast:string` | Coerce to string |
| `cast:number` | Coerce to number |
| `normalize:countryCode` | Uppercase ISO 3166-1 alpha-2 |
| `normalize:currency` | Uppercase ISO 4217 |
| `concat:{fields}` | Join multiple source fields |
| `nested:object` | Build nested object from flat source |
| `array:map` | Map each array element |
| `extensions:passthrough` | Move to extensions bucket |
| `constant:{value}` | Inject fixed value |
| `date:date` | Normalize to canonical calendar date `YYYY-MM-DD` (UPS `YYYYMMDD`, DHL `YYYY-MM-DD`, ISO date-time sources) |
| `date:iso8601` | Normalize to ISO 8601 UTC date-time (FedEx timestamps, etc.) |
| `date:canonical` | Pick `date:date` or `date:iso8601` based on target path (`/estimatedDelivery/date` vs `/dateTime`) |

Combine steps with `|` (e.g. `direct|normalize:countryCode`).

## Response JSON shape

Return **only** valid JSON matching this structure:

```json
{
  "mappings": [
    {
      "sourceField": "/path/to/source",
      "targetField": "/path/to/target",
      "confidence": 0.95,
      "transformation": "direct",
      "reasoning": "Brief explanation"
    }
  ],
  "unmappedSourceFields": ["/unmapped/path"],
  "unmappedTargetFields": ["/required/unmapped"]
}
```

Rules:
- `confidence` is a number between 0 and 1.
- Include all high-value mappings; omit low-confidence guesses.
- List every significant unmapped source and required unmapped target paths.
