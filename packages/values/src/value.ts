/**
 * The Stackbase value model — Convex-compatible. A `Value` is what queries return,
 * mutations write, and the index-key codec encodes. Two numeric types are distinct:
 * `number` is a float64, `bigint` is an int64 (they never compare equal).
 */
export type Value =
  | null
  | boolean
  | number // float64
  | bigint // int64
  | string
  | ArrayBuffer // bytes
  | Value[]
  | { [key: string]: Value };

/** A plain JSON value (the transport form; see `convexToJson`/`jsonToConvex`). */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

export type Cmp = -1 | 0 | 1;

/**
 * The canonical Stackbase total order over values. **Must stay byte-for-byte consistent
 * with the index-key codec** (`@stackbase/index-key-codec`), so that
 * `compareIndexKeys(encode(a), encode(b)) === compareValues(a, b)`.
 *
 * Order by type first, then within type:
 *   null < boolean < number(float64) < bigint(int64) < string < bytes < array < object
 */
const TYPE_RANK = {
  null: 0,
  boolean: 1,
  number: 2,
  bigint: 3,
  string: 4,
  bytes: 5,
  array: 6,
  object: 7,
} as const;

function typeRank(value: Value): number {
  if (value === null) return TYPE_RANK.null;
  switch (typeof value) {
    case "boolean":
      return TYPE_RANK.boolean;
    case "number":
      return TYPE_RANK.number;
    case "bigint":
      return TYPE_RANK.bigint;
    case "string":
      return TYPE_RANK.string;
    case "object":
      if (value instanceof ArrayBuffer) return TYPE_RANK.bytes;
      if (Array.isArray(value)) return TYPE_RANK.array;
      return TYPE_RANK.object;
    default:
      throw new TypeError(`Unsupported value type: ${typeof value}`);
  }
}

const sign = (n: number): Cmp => (n < 0 ? -1 : n > 0 ? 1 : 0);

const utf8 = new TextEncoder();

function compareBytes(a: Uint8Array, b: Uint8Array): Cmp {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return sign(a.length - b.length);
}

function compareNumbers(a: number, b: number): Cmp {
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  // NaN sorts last among numbers, and equals itself (total order requirement).
  if (aNaN || bNaN) return aNaN && bNaN ? 0 : aNaN ? 1 : -1;
  return sign(a - b);
}

function compareKeysUtf8(a: string, b: string): Cmp {
  return compareBytes(utf8.encode(a), utf8.encode(b));
}

export function compareValues(a: Value, b: Value): Cmp {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;

  switch (ra) {
    case TYPE_RANK.null:
      return 0;
    case TYPE_RANK.boolean:
      return sign(Number(a as boolean) - Number(b as boolean));
    case TYPE_RANK.number:
      return compareNumbers(a as number, b as number);
    case TYPE_RANK.bigint: {
      const x = a as bigint;
      const y = b as bigint;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case TYPE_RANK.string:
      return compareKeysUtf8(a as string, b as string);
    case TYPE_RANK.bytes:
      return compareBytes(new Uint8Array(a as ArrayBuffer), new Uint8Array(b as ArrayBuffer));
    case TYPE_RANK.array: {
      const xs = a as Value[];
      const ys = b as Value[];
      const n = Math.min(xs.length, ys.length);
      for (let i = 0; i < n; i++) {
        const c = compareValues(xs[i]!, ys[i]!);
        if (c !== 0) return c;
      }
      return sign(xs.length - ys.length);
    }
    case TYPE_RANK.object: {
      const xo = a as { [k: string]: Value };
      const yo = b as { [k: string]: Value };
      const xk = Object.keys(xo).sort(compareKeysUtf8);
      const yk = Object.keys(yo).sort(compareKeysUtf8);
      const n = Math.min(xk.length, yk.length);
      for (let i = 0; i < n; i++) {
        const kc = compareKeysUtf8(xk[i]!, yk[i]!);
        if (kc !== 0) return kc;
        const vc = compareValues(xo[xk[i]!]!, yo[yk[i]!]!);
        if (vc !== 0) return vc;
      }
      return sign(xk.length - yk.length);
    }
    default:
      return 0;
  }
}

/** Deep value equality, consistent with `compareValues`. */
export function valuesEqual(a: Value, b: Value): boolean {
  return compareValues(a, b) === 0;
}

/** Runtime guard for a plain object value (not null, array, or bytes). */
export function isPlainObject(value: Value): value is { [key: string]: Value } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof ArrayBuffer)
  );
}
