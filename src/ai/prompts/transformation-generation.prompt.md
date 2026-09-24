# Transformation Generation

For each accepted mapping, specify how to transform source values into target values.

## Transformation vocabulary

Use concise, machine-readable expressions:

Every expression below is shown with its **exact, literal** syntax — copy the punctuation
shown; nothing in this table is a placeholder to be filled in with your own bracket style.

| Expression | Meaning |
|------------|---------|
| `direct` | Copy value as-is |
| `cast:string` | Coerce to string |
| `cast:number` | Coerce to number |
| `normalize:countryCode` | Uppercase ISO 3166-1 alpha-2 |
| `normalize:currency` | Uppercase ISO 4217 |
| `concat:/path/a,/path/b` | Join two or more separate absolute source paths, comma-separated (e.g. `concat:/firstName,/lastName`) |
| `concat:{0}` | Take element `0` of the array value at *this mapping's own source field* (the field must resolve to an array). This is the **only** valid array-index token — literally the digit wrapped in curly braces, nothing else. Never write `[0]`, `{[0]}`, `[{0}]`, or any other bracket combination for this. |
| `nested:object` | Build nested object from flat source |
| `array:first` | Take element `0` of an array value, or nothing if the array is empty — equivalent to `concat:{0}` but usable as a single step without wrapping in `concat:` |
| `array:map` | Map each array element |
| `extensions:passthrough` | Move to extensions bucket |
| `constant:"literal value"` | Inject a fixed value, always double-quoted even for a string (e.g. `constant:"oz"`); use `constant:true`, `constant:42`, or `constant:null` (unquoted) for non-string literals |
| `date:date` | Normalize to canonical calendar date `YYYY-MM-DD` (UPS `YYYYMMDD`, DHL `YYYY-MM-DD`, ISO date-time sources) |
| `date:iso8601` | Normalize to ISO 8601 UTC date-time (FedEx timestamps, etc.) |
| `date:canonical` | Pick `date:date` or `date:iso8601` based on target path (`/estimatedDelivery/date` vs `/dateTime`) |

Combine steps with `|` (e.g. `direct|normalize:countryCode`, or `array:first|direct` for
an array source mapped to a scalar target).

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
