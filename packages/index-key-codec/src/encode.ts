/**
 * Order-preserving binary encoding of index-key tuples.
 *
 * The contract that everything else depends on:
 *
 *     compareKeyBytes(encodeIndexKey(a), encodeIndexKey(b)) === compareValues(a, b)
 *
 * i.e. lexicographic byte comparison of encoded keys equals the canonical value order
 * from `@stackbase/values`. This lets the storage layer keep keys in a plain ordered
 * byte index and get correct range scans for free.
 *
 * Each element is `[tag, payload]` where tags are assigned in type order, so different
 * types order by tag alone:
 *   null(0x01) < false(0x02) < true(0x03) < number(0x04) < bigint(0x05) < string(0x06) < bytes(0x07)
 *
 * Per-type payloads are themselves order-preserving:
 *  - float64: IEEE-754 big-endian with the sign trick (negatives flip all bits, others flip the sign bit)
 *  - int64:   big-endian two's-complement with the high (sign) bit flipped
 *  - string/bytes: content with 0x00 escaped as 0x00 0xFF, then a 0x00 terminator (self-delimiting,
 *    so a prefix sorts before a longer string)
 */
/** The subset of values that may appear in an index key (scalars). */
export type IndexableValue = null | boolean | number | bigint | string | ArrayBuffer;

/** A composite index key: an ordered tuple of field values. */
export type IndexKeyTuple = readonly IndexableValue[];

const TAG_NULL = 0x01;
const TAG_FALSE = 0x02;
const TAG_TRUE = 0x03;
const TAG_NUMBER = 0x04;
const TAG_BIGINT = 0x05;
const TAG_STRING = 0x06;
const TAG_BYTES = 0x07;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const utf8 = new TextEncoder();

/** Normalize a value for encoding (collapses `-0` to `+0` to match `compareValues`). */
export function normalizeValue(value: IndexableValue): IndexableValue {
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}

export function compareKeyBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Compare two already-encoded index keys (byte order == value order). */
export const compareIndexKeys = compareKeyBytes;

export function indexKeysEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareKeyBytes(a, b) === 0;
}

function encodeFloat64(n: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, n, false); // big-endian
  if (bytes[0]! & 0x80) {
    // negative: flip all bits so larger magnitude sorts lower
    for (let i = 0; i < 8; i++) bytes[i] = bytes[i]! ^ 0xff;
  } else {
    // non-negative: flip just the sign bit so it sorts above all negatives
    bytes[0] = bytes[0]! ^ 0x80;
  }
  return bytes;
}

function encodeInt64(value: bigint): Uint8Array {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new RangeError(`bigint out of int64 range: ${value}`);
  }
  const bits = BigInt.asUintN(64, value);
  const bytes = new Uint8Array(8);
  let x = bits;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  bytes[0] = bytes[0]! ^ 0x80; // flip sign bit → signed order maps to unsigned byte order
  return bytes;
}

function pushEscaped(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x00) {
      out.push(0x00, 0xff);
    } else {
      out.push(b);
    }
  }
  out.push(0x00); // self-delimiting terminator
}

function pushElement(out: number[], value: IndexableValue): void {
  const v = normalizeValue(value);
  if (v === null) {
    out.push(TAG_NULL);
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? TAG_TRUE : TAG_FALSE);
      return;
    case "number":
      out.push(TAG_NUMBER);
      for (const b of encodeFloat64(v)) out.push(b);
      return;
    case "bigint":
      out.push(TAG_BIGINT);
      for (const b of encodeInt64(v)) out.push(b);
      return;
    case "string":
      out.push(TAG_STRING);
      pushEscaped(out, utf8.encode(v));
      return;
    case "object":
      if (v instanceof ArrayBuffer) {
        out.push(TAG_BYTES);
        pushEscaped(out, new Uint8Array(v));
        return;
      }
      throw new TypeError("index key elements must be scalar values");
    default:
      throw new TypeError(`cannot encode index value of type ${typeof v}`);
  }
}

/** Encode a tuple of field values into an order-preserving key. */
export function encodeIndexKey(values: IndexKeyTuple): Uint8Array {
  const out: number[] = [];
  for (const value of values) pushElement(out, value);
  return Uint8Array.from(out);
}

/** Inclusive lower bound of a prefix scan (`encodeIndexKey(prefix)`). */
export function indexKeyRangeStart(prefix: IndexKeyTuple): Uint8Array {
  return encodeIndexKey(prefix);
}

/**
 * Exclusive upper bound covering every key that begins with `prefix`. Returns `null`
 * for the empty prefix (the whole index, +∞). Works because `0xFF` is greater than any
 * element tag, so it sorts above any continuation of the prefix.
 */
export function indexKeyRangeEnd(prefix: IndexKeyTuple): Uint8Array | null {
  if (prefix.length === 0) return null;
  const start = encodeIndexKey(prefix);
  const end = new Uint8Array(start.length + 1);
  end.set(start, 0);
  end[start.length] = 0xff;
  return end;
}

/** Compare two index-key tuples by value (element-wise; shorter prefix sorts first). */
export function compareIndexTuples(a: IndexKeyTuple, b: IndexKeyTuple): -1 | 0 | 1 {
  return compareKeyBytes(encodeIndexKey(a), encodeIndexKey(b));
}
