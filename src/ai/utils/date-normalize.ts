/**
 * Parse and normalize carrier delivery date values for canonical schema fields.
 * Supports YYYYMMDD (UPS), YYYY-MM-DD (DHL), and ISO-8601 date-time strings (FedEx).
 */

/** Returns true when source/target pair represents a delivery date mapping. */
export function isDeliveryDateMapping(sourceField: string, targetField: string): boolean {
  const sourceLower = sourceField.toLowerCase();
  const targetLower = targetField.toLowerCase();

  if (targetLower.includes("estimateddelivery")) {
    return true;
  }
  if (sourceLower.includes("deliverytimestamp")) {
    return true;
  }
  if (sourceLower.includes("deliverydate") || sourceLower.endsWith("/deliverydate")) {
    return true;
  }
  if (targetField.includes("/dateTime") || /\/date$/.test(targetField)) {
    return (
      sourceLower.includes("delivery") ||
      sourceLower.includes("timestamp") ||
      targetLower.includes("estimateddelivery")
    );
  }

  return false;
}

/** Pipe-delimited transformation for delivery date fields (array unwrap + date step). */
export function inferDeliveryDateTransformation(
  sourceField: string,
  targetField: string,
): string | null {
  if (!isDeliveryDateMapping(sourceField, targetField)) {
    return null;
  }

  const steps: string[] = [];
  if (sourceField.includes("[]") && !targetField.includes("[]")) {
    steps.push("array:first");
  }
  steps.push("direct");
  steps.push(targetField.includes("/dateTime") ? "date:iso8601" : "date:date");
  return steps.join("|");
}

/** Parse a carrier date value into a UTC Date, or undefined when unparseable. */
export function parseCarrierDate(value: unknown): Date | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  const raw = String(value).trim();
  if (!raw) {
    return undefined;
  }

  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return utcDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  }

  const isoDateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    return utcDate(Number(isoDateOnly[1]), Number(isoDateOnly[2]), Number(isoDateOnly[3]));
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return undefined;
}

/** Normalize to canonical calendar date `YYYY-MM-DD`. */
export function toCanonicalDateString(value: unknown): string | undefined {
  const date = parseCarrierDate(value);
  if (!date) {
    return undefined;
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Normalize to canonical ISO-8601 date-time in UTC. */
export function toCanonicalDateTimeString(value: unknown): string | undefined {
  const date = parseCarrierDate(value);
  if (!date) {
    return undefined;
  }

  return date.toISOString();
}

/** Pick date vs date-time normalization based on the canonical target JSON Pointer. */
export function normalizeDateForTarget(value: unknown, targetField: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (targetField.includes("/dateTime")) {
    return toCanonicalDateTimeString(value) ?? value;
  }

  if (targetField.includes("/date")) {
    return toCanonicalDateString(value) ?? value;
  }

  return toCanonicalDateTimeString(value) ?? value;
}

function utcDate(year: number, month: number, day: number): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}
