/**
 * Query planning: turn index range expressions into a single `[start, end)` byte interval.
 * Leading equality constraints form a key prefix; at most one inequality on the next field
 * narrows the bounds. Anything an index can't express is left to the post-filters.
 */
import { encodeIndexKey, indexKeyRangeStart, indexKeyRangeEnd, type IndexableValue } from "@helipod/index-key-codec";

export type ScanOrder = "asc" | "desc";
export type QueryOperator = "eq" | "gt" | "gte" | "lt" | "lte";

export interface RangeExpression {
  field: string;
  operator: QueryOperator;
  value: IndexableValue;
}

export interface IndexInterval {
  start: Uint8Array;
  end: Uint8Array | null; // null = +∞
}

/**
 * Build the scan interval for `fields` given the range constraints. Walks index fields in
 * order, consuming equality constraints into the prefix, then applies up to one lower
 * (gt/gte) and one upper (lt/lte) bound on the first non-equality field.
 */
export function buildIndexInterval(fields: readonly string[], range: readonly RangeExpression[]): IndexInterval {
  const prefix: IndexableValue[] = [];
  let lower: { value: IndexableValue; inclusive: boolean } | null = null;
  let upper: { value: IndexableValue; inclusive: boolean } | null = null;

  for (const field of fields) {
    const constraints = range.filter((r) => r.field === field);
    const eq = constraints.find((c) => c.operator === "eq");
    if (eq) {
      prefix.push(eq.value);
      continue;
    }
    for (const c of constraints) {
      if (c.operator === "gt") lower = { value: c.value, inclusive: false };
      else if (c.operator === "gte") lower = { value: c.value, inclusive: true };
      else if (c.operator === "lt") upper = { value: c.value, inclusive: false };
      else if (c.operator === "lte") upper = { value: c.value, inclusive: true };
    }
    break; // only one bounded field after the equality prefix
  }

  const start = lower
    ? lower.inclusive
      ? encodeIndexKey([...prefix, lower.value]) // gte: include keys with field == value
      : (indexKeyRangeEnd([...prefix, lower.value]) ?? new Uint8Array(0)) // gt: exclude that whole prefix
    : indexKeyRangeStart(prefix);

  const end = upper
    ? upper.inclusive
      ? indexKeyRangeEnd([...prefix, upper.value]) // lte: include the value's prefix
      : encodeIndexKey([...prefix, upper.value]) // lt: exclusive at the value
    : indexKeyRangeEnd(prefix);

  return { start, end };
}
