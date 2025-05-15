---
title: Foundation — Order-Preserving Index-Key Codec & Range Algebra
slug: index-key-codec
status: design (implementation-ready)
slice: Foundation (Tier 0)
depends_on: [monorepo-tooling-skeleton]
audience: engineering (internal)
---

# Order-Preserving Index-Key Codec & Range Algebra

> Clean-room design. We studied the `@concavejs/*` `.d.ts` contracts (FSL-1.1; in
> gitignored `.reference/`) only for the **shape** of the surface. Every byte format,
> transform, and algorithm below is our own and must be re-derived and proven by the
> property tests in §10. **Never copy reference source into this package.**

This is the load-bearing primitive of the whole engine. It encodes Convex value tuples
into byte strings whose **lexicographic byte order equals logical sort order**, and it
defines the shared `KeyRange` / `RangeSet` read/write-set representation used *identically*
by the query engine (read sets), the transactor (OCC + write sets), and the sync tier
(invalidation matching). Get this exactly right and indexes, cursors, OCC, and reactivity
all follow; get it wrong and every one of them silently corrupts.

---

## 1. Purpose & boundaries

### What it owns
- The **order-preserving binary codec**: `encodeIndexKey` / `decodeIndexKey` for tuples of
  the six indexable Convex scalar types, with `byteCompare(encode(a), encode(b)) ==
  logicalCompare(a, b)` as an *exhaustively property-tested invariant*.
- The **range-bound constructors**: `indexKeyRangeStart` / `indexKeyRangeEnd` and the
  Convex-range-expression → byte-bounds lowering (`rangeExpressionsToIndexBounds`).
- The **range algebra**: the `KeyRange` interval type, `RangeSet` (read/write-set
  collection), namespaced `Keyspace` ids (`table:` / `index:`), the overlap/containment
  predicates that OCC and subscription matching both call, and the byte comparator
  (`compareKeyBytes`) every consumer shares.
- The **serialization seam**: `SerializedKeyRange` (hex form) + `serializeKeyRange` /
  `deserializeKeyRange` — the wire shape that lets a write-set cross a process boundary.
- The **stable cursor codec**: `IndexCursor` / `SimpleCursor` carrying `(indexKey, _id)`,
  plus `encodeCursor` / `decodeCursor`.
- `extractIndexKey(doc, fields)` — pure "read these field paths, encode the tuple" helper
  (companion; the IndexManager composes it).

### What it does NOT own (explicit non-goals)
- **No storage.** It never imports a DB driver, never touches the `DocStore`. It produces
  and compares bytes; the storage layer persists them. (`index_scan` consumes the bounds
  this package builds, but lives in the storage component.)
- **No query planning.** It does not parse `db.query(...)`, choose indexes, or split
  bound-predicates from post-filters. The planner (query-engine component) calls
  `rangeExpressionsToIndexBounds`; it does not live here.
- **No index maintenance.** `IndexManager.generateUpdates(...)` (which add/delete keys on
  write) lives in the query-engine component; it *uses* `extractIndexKey`.
- **No OCC logic, no subscription manager, no interval tree.** This package supplies the
  `KeyRange`/`RangeSet`/`compareKeyBytes` primitives and the linear `rangesOverlap` oracle.
  The transactor builds OCC on top; the sync tier builds the interval tree on top (and
  validates it against our linear oracle in tests).
- **No document-ID codec.** The developer-facing `k57x3n8j...` id string (varint +
  Fletcher-16 + Crockford base32) is the storage component's concern. Here, an `_id` is
  just a `string` value the codec orders like any other string.
- **No schema/validator system.** It validates only that a value is one of the six
  indexable scalar types; rich Convex validators belong to codegen/schema.

### Boundary diagram
```
  query-engine ──┐                         ┌── transactor (OCC: read-set vs write-set)
  (read sets,    │   encodeIndexKey         │
   planner,      ├──► compareKeyBytes  ◄────┤   sync tier (subscription read-set vs
   IndexManager) │   KeyRange / RangeSet    │    committed write-set; interval tree)
  cursors  ──────┘   SerializedKeyRange     └── write-fanout / change-stream (Tier 2)
                     (this package: @stackbase/keys — zero deps, isomorphic)
```

---

## 2. The value model

Index-key fields are the six **ordered scalar** Convex types. v1 supports exactly these;
arrays/objects are reserved (§9, open issue 4).

```ts
/** The six indexable scalar Convex value types, v1. */
export type IndexableValue =
  | null
  | boolean
  | number      // Convex Float64 (IEEE-754 double)
  | bigint      // Convex Int64 (64-bit signed; NOT arbitrary precision in v1)
  | string      // Unicode; ordered by UTF-8 byte sequence
  | Uint8Array; // Convex Bytes

/** A composite index key is an ordered tuple of field values. */
export type IndexKeyTuple = readonly IndexableValue[];
```

**The total order (LOCKED contract — every consumer depends on it):**

```
null  <  boolean  <  number (float64)  <  bigint (int64)  <  string  <  bytes
```

Within a type:
- `boolean`: `false < true`.
- `number`: IEEE order with `-Infinity < … < -0 == +0 < … < +Infinity < NaN`
  (−0 normalized to +0; all NaN bit-patterns collapse to one position — see §3.2).
- `bigint`: signed two's-complement order, `INT64_MIN < … < -1 < 0 < 1 < … < INT64_MAX`.
- `string`: lexicographic by **UTF-8 bytes** (= Unicode code-point order).
- `bytes`: lexicographic by raw unsigned octets.

> Note: this is the *project's stated order*. It differs from upstream Convex in two ways
> we deliberately surface as open issues (§11): Convex bands `Int64 < Float64`
> (we state `number < bigint`), and Convex also orders array/object after bytes. The
> property-test gate enforces *our* order; a compatibility audit must reconcile the
> number/bigint band and the missing aggregate types before GA.

### Normalization
Encoding is **canonicalizing** (and therefore mildly lossy by design):

```ts
/** Canonicalize a value into the exact form the codec encodes & decode returns. */
export function normalizeValue(v: IndexableValue): IndexableValue;
//  -0        -> +0
//  any NaN   -> CANONICAL_NAN (0x7ff8000000000000)
//  others    -> unchanged
```

`decodeIndexKey(encodeIndexKey(t))` deep-equals `t.map(normalizeValue)`, **not** raw `t`.
This is required: −0 and +0 must produce *byte-identical* keys (else they sort unequal),
and distinct NaN payloads must collapse to one key.

---

## 3. The byte format (exact)

A tuple encodes as the concatenation of per-field encodings. Each field is
`[1-byte type tag][payload]`, where payloads are either fixed-length or self-delimited by a
terminator. **Self-delimitation is mandatory**: it is what makes prefix comparison and
multi-field concatenation order-correct.

### 3.1 Type tags
Tags are chosen so the tag bytes themselves ascend in type order:

| Type    | Tag    | Payload |
|---------|--------|---------|
| null    | `0x00` | (none) |
| boolean | `0x01` | 1 byte: `0x00`=false, `0x01`=true |
| number  | `0x02` | 8 bytes: order-preserving float64 (§3.2) |
| bigint  | `0x03` | 8 bytes: order-preserving int64 (§3.3) |
| string  | `0x04` | escaped UTF-8 + terminator (§3.4) |
| bytes   | `0x05` | escaped octets + terminator (§3.4) |
| *array* | `0x06` | **reserved**, v-future (open issue 4) |
| *object*| `0x07` | **reserved**, v-future (open issue 4) |

Constants live in `codec.ts` as `const TAG = { NULL:0x00, BOOL:0x01, NUMBER:0x02,
BIGINT:0x03, STRING:0x04, BYTES:0x05 } as const`. Tag space `0x06/0x07` is reserved now so
adding aggregates later does not renumber and re-order existing data.

### 3.2 Float64 transform (order-preserving)
```
encodeFloat64(n):
  if isNaN(n): n = CANONICAL_NAN          // 0x7ff8000000000000
  if n === 0:  n = 0                       // normalize -0 -> +0
  b = bigEndian(float64Bits(n))            // 8 bytes, DataView.setFloat64(_, false)
  if (b[0] & 0x80) != 0:  for i: b[i] ^= 0xff   // negative: invert ALL bits
  else:                   b[0] ^= 0x80          // non-negative: flip sign bit
  return b
decodeFloat64(b):  // inverse
  if (b[0] & 0x80) != 0:  b' = clearTopBit(b)         // was non-negative
  else:                   b' = invertAll(b)           // was negative
  return readFloat64BE(b')
```
Result ordering: `-Inf < negatives(reversed→correct) < -0=+0 < positives < +Inf < NaN`.
NaN sits just above `+Inf` (sign-0 canonical NaN `0x7ff8…` → `0xfff8…` > `+Inf`'s
`0xfff0…`). This is a *defined, deterministic* position (open issue 2 tracks Convex parity).

### 3.3 Int64 transform (order-preserving)
```
encodeInt64(v):
  if v < INT64_MIN or v > INT64_MAX: throw RangeError
  u = BigInt.asUintN(64, v) ^ 0x8000000000000000n   // flip sign bit
  return bigEndian8(u)
decodeInt64(b):
  return BigInt.asIntN(64, bigEndianToU64(b) ^ 0x8000000000000000n)
```
Maps `INT64_MIN→0x0000…`, `-1→0x7fff…`, `0→0x8000…`, `INT64_MAX→0xffff…`. Monotonic across
the sign boundary — the exact edge the acceptance gate fuzzes.

### 3.4 String & bytes (escaped, self-delimited)
Length-prefixing would break order (`"b"`@len1 would precede `"aa"`@len2). We use the
proven FoundationDB-style escape instead:

```
escape(payload):  every 0x00 byte -> 0x00 0xff ; then append terminator 0x00
unescape(stream): read until a 0x00 NOT followed by 0xff (that 0x00 is the terminator);
                  collapse each 0x00 0xff back to 0x00
```
Strings encode `escape(utf8(s))`; bytes encode `escape(raw)`. Because real `0x00` becomes
`0x00 0xff` and the terminator is a lone `0x00` (always `< 0xff` and `<` any following type
tag `≤ 0x05`), ordering and prefix-separation are exact:
- `"" < "a" < "ab" < "b"` ✓
- `"a" < "ab"` because after the shared `0x61` the terminator `0x00` < `'b'`=`0x62` ✓
- embedded NUL: `"" < "\x00" < "\x01"` ✓ and `"ab"` is *excluded* from the `f0=="a"` prefix
  range because `"a"`'s terminator `0x00` < `"ab"`'s `0x62` (this is what makes `strinc`
  bounds in §4 correct).

UTF-8 byte order equals Unicode code-point order, so string comparison is correct by
construction. (`TextEncoder` maps lone surrogates to U+FFFD — lossy only for invalid
strings; Convex strings are well-formed Unicode.)

### 3.5 Composite & prefix behavior
Concatenating self-delimited fields yields a key where a **shorter tuple is a byte-prefix of
any longer tuple that extends it**, hence sorts first: `[a] < [a,null] < [a,false] <
[a,0] < …`. A `null` field is the single byte `0x00`; it never collides with a string
terminator because the parser walks fields by tag from known boundaries. This prefix
property is the foundation of both range scans (§4) and stable cursors (§7).

---

## 4. Range-bound construction

A query that fixes the first *k* fields of an index scans a contiguous byte interval
`[start, end)`. The codec builds those bounds.

```ts
/** Inclusive lower bound = the exact encoded prefix. */
export function indexKeyRangeStart(values: IndexKeyTuple): Uint8Array;
//  === encodeIndexKey(values)

/** Exclusive upper bound for a prefix scan; null = unbounded to +infinity. */
export function indexKeyRangeEnd(values: IndexKeyTuple): Uint8Array | null;
//  === strinc(encodeIndexKey(values))
```

`strinc` ("string increment") is the canonical successor of "all keys having this prefix":
```
strinc(bytes):
  i = last index where bytes[i] != 0xff
  if none: return null                 // no finite successor (all 0xff) -> +infinity
  return bytes[0..i] with bytes[i]+1   // increment, drop the trailing 0xff run
```
Every key sharing prefix `P` lies in `[P, strinc(P))`; everything else is excluded
(proven in §3.4's `"ab" ∉ f0=="a"` example). `encodeIndexKey([])` is the empty key, so
`indexKeyRangeStart([]) = <empty>` and `indexKeyRangeEnd([]) = null` — i.e. `[]` denotes a
whole-index scan `[<empty>, +∞)`, exactly the table-scan semantics §6 needs.

### 4.1 Lowering Convex range expressions
The planner hands us the index's field list plus the user's `withIndex` bound expressions;
we fold leading equalities into a fixed prefix and one trailing inequality into the open end.

```ts
export interface RangeExpression {
  type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
  fieldPath: string[];        // dotted path components
  value: IndexableValue;
}

export interface IndexBounds {
  start: Uint8Array;          // inclusive
  end: Uint8Array | null;     // exclusive; null = +infinity
}

/** Walk index fields in order: consume leading Eq as prefix, fold one trailing
 *  inequality into the open end. Throws on a non-prefix / multi-inequality shape
 *  the planner should have rejected. */
export function rangeExpressionsToIndexBounds(
  expressions: readonly RangeExpression[],
  indexFields: readonly string[],
): IndexBounds;
```
Given prefix equalities `E = [e₀…e_{k-1}]` and an optional trailing inequality on field *k*:

| trailing op | `start` | `end` |
|---|---|---|
| (none)   | `encode(E)`          | `strinc(encode(E))` |
| `Gte x`  | `encode([...E, x])`  | `strinc(encode(E))` |
| `Gt x`   | `strinc(encode([...E, x]))` | `strinc(encode(E))` |
| `Lte x`  | `encode(E)`          | `strinc(encode([...E, x]))` |
| `Lt x`   | `encode(E)`          | `encode([...E, x])` |

Bounds are scan-direction-independent; `order: "asc"|"desc"` only flips iteration.

---

## 5. Comparison & the range algebra

### 5.1 Comparators
```ts
/** THE hot-path primitive: unsigned lexicographic compare of two encoded keys.
 *  (The reference calls this compareArrayBuffers; OCC, the interval tree, and
 *  cursor math all bottom out here.) */
export function compareKeyBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1;

/** Ergonomic tuple comparator. INVARIANT (property-tested, §10):
 *  sign(compareIndexKeys(a,b)) === sign(compareKeyBytes(encodeIndexKey(a), encodeIndexKey(b))) */
export function compareIndexKeys(a: IndexKeyTuple, b: IndexKeyTuple): -1 | 0 | 1;

export function indexKeysEqual(a: IndexKeyTuple, b: IndexKeyTuple): boolean;
```

### 5.2 Keyspace (namespacing)
A `KeyRange` is scoped to a keyspace so an index write matches an index read (and a table
write matches a table read) without cross-talk.

```ts
export type Keyspace =
  | { kind: "table"; table: string }                 // a table's primary keyspace
  | { kind: "index"; table: string; index: string }; // one secondary index

/** Canonical string id used as KeyRange.tableId. `table` is the opaque storage table id
 *  (e.g. tableNumber as string / hex) — this package treats it as opaque. */
export function keyspaceId(ks: Keyspace): string;     // "table:<table>" | "index:<table>:<index>"
export function parseKeyspaceId(id: string): Keyspace;
export function tableKeyspaceId(table: string): string;
export function indexKeyspaceId(table: string, index: string): string;
```

### 5.3 KeyRange & overlap
```ts
/** Half-open interval [startKey, endKey) within one keyspace.
 *  - endKey === null  => unbounded to +infinity
 *  - isPoint === true => the single key startKey (endKey mirrors startKey for uniform
 *    serialization); semantics are the closed point {startKey}. */
export interface KeyRange {
  tableId: string;          // a keyspaceId()
  startKey: Uint8Array;     // inclusive lower bound (encoded)
  endKey: Uint8Array | null;// exclusive upper bound, or null = +infinity
  isPoint: boolean;
}

/** Lexical containment: is single key `k` inside range `r`? (point-write vs read-range —
 *  the dominant invalidation test). */
export function keyInRange(k: Uint8Array, r: KeyRange): boolean;

/** Do two ranges in the SAME keyspace share any key? The one overlap predicate OCC and
 *  subscription matching both use. Half-open aware: ranges touching only at an exclusive
 *  bound do NOT overlap. */
export function rangesOverlap(a: KeyRange, b: KeyRange): boolean;
```
`rangesOverlap` truth (same `tableId`; treat `null` end as +∞):
- point `p` vs `[s,e)`: `s ≤ p` and (`e===null` or `p < e`).
- `[s₁,e₁)` vs `[s₂,e₂)`: (`e₂===null` or `s₁ < e₂`) and (`e₁===null` or `s₂ < e₁`).
- point vs point: `p₁ == p₂`.
Different `tableId` ⇒ never overlap (cheap early-out).

### 5.4 RangeSet
The single shared read/write-set representation.

```ts
export class RangeSet {
  // ---- builders (mirror how reads/writes are recorded) ----
  /** Point read/write of a document: key = encoded developer id within the table keyspace. */
  addDocument(args: { table: string; key: Uint8Array }): void;
  /** Contiguous index interval actually scanned. end=null => ran to +infinity. */
  addIndexRange(table: string, index: string, startKey: Uint8Array, endKey: Uint8Array | null): void;
  /** Whole-table dependency (no narrowing index): [<empty>, +infinity) on the table keyspace. */
  addTableScan(table: string): void;
  /** Generic escape hatches. */
  addPointKey(tableId: string, key: Uint8Array): void;
  addRange(range: KeyRange): void;

  // ---- inspection ----
  getRanges(): KeyRange[];
  getRangesByTable(): Map<string, KeyRange[]>;   // keyed by tableId
  getTables(): Set<string>;                       // set of tableId keyspace strings
  readonly size: number;
  isEmpty(): boolean;

  // ---- lifecycle (savepoint-friendly for the transactor) ----
  clone(): RangeSet;
  replaceWith(other: RangeSet): void;
  clear(): void;

  // ---- algebra (OCC conflict + subscription match bottom out here) ----
  intersectsRange(range: KeyRange): boolean;      // any of my ranges overlaps `range`
  intersects(other: RangeSet): boolean;           // do two sets share any key (per tableId)

  // ---- serialization seam (§8) ----
  serialize(): SerializedKeyRange[];
  static deserialize(s: readonly SerializedKeyRange[]): RangeSet;
}

/** Coarse table-level fallback signal (Foundation's v1 invalidation granularity):
 *  the deduped set of table keyspace ids touched by these ranges. */
export function writtenTablesFromRanges(ranges: readonly KeyRange[]): string[];
```
`intersects` groups by `tableId` then runs `rangesOverlap` pairwise (the linear oracle the
sync tier's interval tree must match, never under-report — §10). At Foundation's
**table-level** invalidation default, the transactor/sync tier may use
`writtenTablesFromRanges` + `getTables()` for matching and keep the precise range data
ready for the later interval-tree optimization — no representational change required.

---

## 6. Tier 0 (single binary) — how it works NOW

Everything is one process; the codec is pure and synchronous.

1. **Write path.** A mutation stages writes. The IndexManager (query-engine component) calls
   `extractIndexKey(doc, fields)` per index to get the new/old key bytes, emits add/delete
   index updates, and records each written document/index key into the transaction's **write
   `RangeSet`** (`addDocument` / `addIndexRange`). On commit the transactor has a write
   `RangeSet` of `Uint8Array`-keyed `KeyRange`s.
2. **Read path.** A query scans `index_scan(indexId, tableId, readTs, {start,end}, order)`
   where `{start,end}` came from `rangeExpressionsToIndexBounds`. *As it scans*, the executor
   records the exact interval it consumed (up to the last key examined for a limited page)
   into the query's **read `RangeSet`**. Cursors carry `(indexKey, _id)` (§7).
3. **OCC (transactor).** Commit Phase-1 validation asks "did anything I read change?" The
   read-set/write-set machinery uses `compareKeyBytes` + `keyInRange`/`rangesOverlap` for the
   range/phantom checks; the per-document version chain (storage component) handles point
   versions. The codec/algebra here is the conflict primitive.
4. **Reactivity (sync tier).** On commit the runtime hands the write `RangeSet` to the sync
   handler via the write-fanout publisher (§8). The handler intersects committed write ranges
   against each live subscription's recorded read ranges (table-level set match in v1;
   `rangesOverlap` ready for range-precision later) and recomputes the overlapping
   subscriptions. **The same `RangeSet` representation serves OCC and reactivity** — the
   elegant core we keep.
5. **Pagination.** `paginate()` over a 100-row dev table runs the exact mechanics it will run
   over a billion-row conversation: order-preserving `index_scan` + `(indexKey,_id)` cursor.

All `KeyRange`s stay in-memory `Uint8Array` form on this hot path — no serialization cost
until a payload crosses the fan-out boundary (§8).

---

## 7. Stable cursors `(indexKey, _id)`

```ts
export type SimpleCursor = { type: "simple"; id: string };
export type IndexCursor  = { type: "index"; id: string; indexKey: IndexableValue[] };
export type Cursor = SimpleCursor | IndexCursor;

/** Index cursor -> URL-safe base64 (carries decoded indexKey + id); simple cursor -> bare id. */
export function encodeCursor(cursor: Cursor): string;
/** Inverse. Untrusted input: throws InvalidCursorError on malformed/garbage strings. */
export function decodeCursor(s: string): Cursor;
export function getCursorId(cursor: Cursor): string;

export class InvalidCursorError extends Error {}
```
The cursor stores the **decoded** `indexKey` (a `Value[]`) plus the unique `_id`. Resume =
"strictly after `(indexKey, _id)`": the executor re-encodes `[...indexKey, _id]` and starts
the next page at `strinc` of that exact key (or sets the inclusive/exclusive bound per scan
direction). Because the trailing `_id` is unique and the encoding is order-preserving, a
new head insert sharing the same field values lands **deterministically** before or after
the cursor — never shifting it, never skipping or duplicating a row under concurrent
inserts. This is exactly the stability the infinite-scrollback path (spectrum §2.6) needs,
and it is identical code at Tier 0 and Tier 2.

`_id` is encoded as a `string` value here; its own internal order-preserving property
(Crockford base32, storage component) keeps the tiebreak total and stable.

---

## 8. Scale seam — reserved now, attaches later with NO rewrite

> Seam: *`SerializedKeyRange` (hex form) is what lets a commit's write-set cross a process
> boundary to a distributed change-stream and sync fleet (spectrum rows 4, 10); the
> order-preserving encoding is what makes `(indexKey,_id)` cursors stable, enabling
> infinite-history pagination that never skips or dupes under concurrent head-inserts (row 7).*

### 8.1 `SerializedKeyRange` (rows 4 & 10)
```ts
/** JSON-safe, wire form of a KeyRange. Bytes are hex (lowercase, no prefix). */
export interface SerializedKeyRange {
  tableId: string;
  startKey: string;          // hex of startKey
  endKey: string | null;     // hex of endKey, or null
  isPoint: boolean;
}
export function serializeKeyRange(r: KeyRange): SerializedKeyRange;
export function deserializeKeyRange(s: SerializedKeyRange): KeyRange;
```
**Rule:** anything that crosses a process/wire boundary uses `SerializedKeyRange`, never an
in-memory `Uint8Array`. The write-fanout / change-stream payloads carry it from day one:

```ts
// Defined by the transactor/runtime components; this package provides SerializedKeyRange.
interface WriteInvalidation {
  writtenRanges?: SerializedKeyRange[];   // <-- serialized, always
  writtenTables?: string[];
  commitTimestamp?: string;               // u64 as string
  snapshotTimestamp?: string;
  shardId?: string;                       // "default" at Tier 0
}
// OplogDelta / ChangeDelta reuse the same SerializedKeyRange[] shape.
```
At **Tier 0** the `EmbeddedWriteFanout` adapter is an in-memory channel, but it still
publishes `SerializedKeyRange` (negligible hex cost at single-binary write rates) so the
wire shape is *real and identical* to Tier 2 — no "works in-process, breaks on the wire"
surprise. At **Tier 2** the committer emits the same `SerializedKeyRange[]` onto the
change-stream; every sync node `deserializeKeyRange`s back to `KeyRange` and runs the
**same** `rangesOverlap`. The reactive logic is byte-for-byte unchanged across the cut —
only the transport (in-memory channel → BroadcastChannel/Redis/Queue) differs. Row 10 (wire
efficiency) is independent: the result-delta encoding can become binary later without
touching `SerializedKeyRange`.

### 8.2 Order-preserving cursors (row 7)
Covered in §7 — the `(indexKey,_id)` `IndexCursor` + order-preserving codec are the entire
mechanism; Tier 2 sharding changes *where* a page is read, never *how* the cursor resolves.

### 8.3 What stays invariant across the spectrum
`encodeIndexKey`, `compareKeyBytes`, `KeyRange`, `RangeSet`, and the `SerializedKeyRange`
shape are identical at Endpoint A (`$5` VPS) and Endpoint B (WhatsApp). Promoting tiers
changes the fan-out *adapter* and the *router*, never these types — which is precisely why
they must be frozen and golden-vector-tested before any data is persisted (open issue 7).

---

## 9. Package / module / file layout

A dedicated, single-purpose, **zero-dependency, isomorphic** package (works unchanged on
Node / Bun / Cloudflare Workers / browser — only `Uint8Array`, `DataView`, `TextEncoder`,
`BigInt`). It is depended on by `packages/server` (query engine, transactor, sync tier) *and*
`packages/client` (cursor + compare for optimistic ordering) and a future standalone Tier 2
sync node — hence its own package, not a server-internal module.

```
packages/keys/                      (@stackbase/keys)
├── package.json                    # no runtime deps; "sideEffects": false; ESM
├── tsconfig.json
├── src/
│   ├── index.ts                    # barrel: re-exports the public surface below
│   ├── value.ts                    # IndexableValue, IndexKeyTuple, normalizeValue, isIndexableValue, CANONICAL_NAN, INT64_MIN/MAX
│   ├── codec.ts                    # TAG, encodeIndexKey, decodeIndexKey, encode/decode Float64 & Int64, escape/unescape
│   ├── compare.ts                  # compareKeyBytes, compareIndexKeys, indexKeysEqual
│   ├── range-bounds.ts             # strinc, indexKeyRangeStart, indexKeyRangeEnd, RangeExpression, IndexBounds, rangeExpressionsToIndexBounds
│   ├── keyspace.ts                 # Keyspace, keyspaceId, parseKeyspaceId, tableKeyspaceId, indexKeyspaceId
│   ├── key-range.ts                # KeyRange, keyInRange, rangesOverlap, SerializedKeyRange, serialize/deserializeKeyRange
│   ├── range-set.ts                # RangeSet, writtenTablesFromRanges
│   ├── cursor.ts                   # Cursor types, encodeCursor, decodeCursor, getCursorId, InvalidCursorError
│   ├── extract.ts                  # extractIndexKey(doc, fields), resolveFieldPath
│   └── hex.ts                      # bytesToHex/hexToBytes, base64url encode/decode (cursor)
└── test/
    ├── ordering.property.test.ts   # THE acceptance gate (§10.1)
    ├── roundtrip.property.test.ts  # decode∘encode == normalize (§10.1)
    ├── codec.edges.test.ts         # float sign/NaN, int64 boundaries, strings/bytes/escape (§10.2)
    ├── range-bounds.test.ts        # strinc, prefix inclusion, Eq/Gt/Gte/Lt/Lte lowering (§10.3)
    ├── range-algebra.test.ts       # keyInRange, rangesOverlap, RangeSet.intersects, OCC cases (§10.4)
    ├── serialize.test.ts           # SerializedKeyRange + RangeSet round-trip, JSON-safety (§10.5)
    ├── cursor.test.ts              # cursor round-trip, resume math, concurrent-head-insert stability (§10.6)
    ├── keyspace.test.ts            # id <-> parse round-trip
    └── golden-vectors.test.ts      # frozen tuple->hex fixtures: regression guard for the durable format (§10.7)
```
Public surface = exactly the exports named above; `index.ts` is the only entry point.

---

## 10. Test strategy

Property tests (use `fast-check` under `vitest`) are the **acceptance gate** the component
spec mandates; the codec is durable on-disk/on-wire format, so coverage must be exhaustive.

### 10.1 Property tests — the gate
- **Round-trip:** `∀ tuple t: decodeIndexKey(encodeIndexKey(t)) deepEquals t.map(normalizeValue)`.
  Generators cover all six types incl. `-0`, multiple NaN payloads, `±Inf`, subnormals,
  `INT64_MIN/MAX`, empty/embedded-NUL strings & bytes, multibyte UTF-8, empty tuple.
- **Ordering (load-bearing):** `∀ a,b: sign(compareIndexKeys(a,b)) ===
  sign(compareKeyBytes(encodeIndexKey(a), encodeIndexKey(b))) === sign(referenceCompare(a,b))`,
  where `referenceCompare` is an **independent** implementation of §2's logical order
  (type-band ordinal, then within-type compare). Disagreement = fail. This single property
  is what proves "byte order == sort order."
- **Order axioms:** reflexivity, antisymmetry, transitivity (sampled triples).

### 10.2 Codec edge units (named in the spec)
- **Float sign / NaN:** `-0` and `+0` encode byte-identically; strict chain
  `-Inf < -MAX < -1 < -min_subnormal < -0=+0 < +min_subnormal < 1 < +MAX < +Inf < NaN`;
  several NaN bit-patterns collapse to one key.
- **Bigint sign boundary:** `INT64_MIN < -2 < -1 < 0 < 1 < 2 < INT64_MAX` strictly
  increasing; out-of-range bigint throws `RangeError`.
- **Cross-type bands:** `null < false < true < (+Inf as number) < (INT64_MIN as bigint) <
  "" (string) < (empty bytes)` — i.e. an extreme of each band still sits below the next
  band's minimum.
- **String/bytes:** `"" < "a" < "ab" < "b"`; `"\x00"` ordering & escape; `"a\x00b"` vs `"a"`;
  emoji/non-BMP vs BMP; bytes `[] < [0x00] < [0x00,0x00] < [0x01] < [0xff]`.
- **Composite/prefix:** `[a] < [a,null] < [a,false] < [a,0]`; `"ab"` excluded from `f0=="a"`.

### 10.3 Range bounds
- `strinc`: increments last non-`0xff`, drops trailing `0xff`; all-`0xff` ⇒ `null`.
- **Prefix inclusion (property):** generate a prefix `p` and a population of full keys;
  `encode(t) ∈ [indexKeyRangeStart(p), indexKeyRangeEnd(p))` **iff** `t` extends `p`.
  Cross-checked against a brute-force "does `t` start with `p`" predicate.
- **Inequality lowering:** for each of `Gt/Gte/Lt/Lte` (+ Eq-only), the `[start,end)` from
  `rangeExpressionsToIndexBounds` selects exactly the keys a brute-force predicate selects,
  over a generated key population. Includes empty-prefix (whole-index) and the boundary value
  itself (Gte includes `x`, Gt excludes it; Lt excludes `x`, Lte includes it).

### 10.4 Range algebra & OCC conflict cases (the spec's OCC gate, at the primitive layer)
- `keyInRange` / `rangesOverlap` truth table: point-in-range, disjoint, **touching only at
  the exclusive bound ⇒ NO overlap**, unbounded (`null`) ends (one and both), point==point,
  different `tableId` ⇒ no overlap.
- **OCC conflict** (the transactor composes these): read `RangeSet` vs write `RangeSet`
  `intersects()` is `true` iff a written key lands in a read range. Cases:
  - *phantom insert*: read range `[a,c)`, write inserts key `b∈[a,c)` ⇒ conflict.
  - *point read of absent doc*: read point `k`, write inserts `k` ⇒ conflict.
  - *no conflict*: read `[a,b)`, write at `c ≥ b` ⇒ none (exclusive bound).
  - *self-write excluded*: a key present in both read and write sets is the transaction's own
    write — validated as non-conflict by the transactor passing its written-key set (this
    package supplies the membership test; the exclusion policy lives in the transactor).
- **Differential oracle:** `RangeSet.intersects` (linear) is the reference the sync tier's
  interval tree is later tested against — assert the tree never under-reports vs this.

### 10.5 Serialization
- `serializeKeyRange → deserializeKeyRange` reproduces byte-identical `startKey`/`endKey`,
  `isPoint`, `tableId`; `RangeSet.serialize → deserialize` reproduces an equal set.
- `JSON.parse(JSON.stringify(serialized))` survives (no `Uint8Array`/`bigint` leakage); hex
  is lowercase and stable; `null` end preserved.

### 10.6 Cursors
- `encodeCursor → decodeCursor` round-trip for both shapes; `decodeCursor` of garbage /
  truncated / wrong-prefix input throws `InvalidCursorError` (fuzzed — never crashes).
- **Resume math:** next page starts strictly after `(indexKey,_id)`.
- **Concurrent-head-insert stability (row 7):** build an index population, take a page +
  cursor, insert a new head row with the *same field values* as an existing row, resume —
  assert no row skipped and none duplicated across the page boundary.

### 10.7 Format freeze & cross-runtime determinism
- **Golden vectors:** a checked-in table of `tuple → expected hex` (and a few full
  `SerializedKeyRange` fixtures). Any change to the byte format fails this test loudly —
  because changing the codec after data exists is a migration, not a refactor (open issue 7).
- **Determinism:** the same vectors produce identical bytes under Node and Bun in CI (pure
  functions, no clock/random/global state).

---

## 11. Failure & edge handling (summary)

| Case | Behavior |
|---|---|
| `-0` input | normalized to `+0`; byte-identical key (decode returns `+0`) |
| any `NaN` input | normalized to one canonical NaN; sorts just above `+Inf` |
| `bigint` outside Int64 | `encodeIndexKey` throws `RangeError` (validation) |
| non-indexable value (array/object/`undefined`/symbol/function) | throws `TypeError` with the offending type (v1; arrays/objects reserved §3.1) |
| empty tuple `[]` | empty key; `start=<empty>`, `end=null` ⇒ whole-index scan |
| `strinc` of all-`0xff` | `null` (unbounded upper bound) |
| malformed bytes into `decodeIndexKey` | throws (unknown tag / truncated / bad escape) — never silent |
| garbage/forged cursor string | `decodeCursor` throws `InvalidCursorError`; query layer surfaces an error rather than serving a wrong page |
| `KeyRange` with `isPoint` | invariant `endKey` mirrors `startKey`; asserted in dev builds |
| lone surrogate in string | `TextEncoder` → U+FFFD (lossy only for invalid Unicode) |
| ranges in different `tableId` | `rangesOverlap` returns `false` immediately |

---

## 12. Implementation order (for the engineer)

1. `value.ts` + `codec.ts` (encode/decode, the four transforms, escape) — **with** the
   ordering + round-trip property tests green. Nothing else proceeds until §10.1 passes.
2. `compare.ts`, `range-bounds.ts` (+ §10.2/§10.3 tests).
3. `keyspace.ts`, `key-range.ts`, `range-set.ts` (+ §10.4 tests, incl. the OCC cases).
4. `hex.ts`, serialization on `KeyRange`/`RangeSet` (+ §10.5).
5. `cursor.ts` (+ §10.6, incl. the concurrent-head-insert stability test).
6. `extract.ts`.
7. `golden-vectors.test.ts` — freeze the format (§10.7) once §10.1 is locked.

---

## Open issues (carry into review / the compatibility audit)

1. **number-vs-bigint band order vs upstream Convex.** We lock `number < bigint`; Convex
   bands `Int64 < Float64` (bigint < number). This inverts cross-type ordering of every
   number/bigint pair and is client-interop-visible. Confirm whether the project's stated
   order is deliberate or a doc typo *before GA*; the property tests enforce whatever we
   decide, but the wire-compat target must agree.
2. **NaN position & admissibility.** We place canonical NaN just above `+Inf` and collapse
   all NaN payloads. Confirm Convex's behavior (does it permit NaN in an index key at all, or
   reject it?) and match — reject-at-encode is a viable alternative if Convex forbids it.
3. **String collation: UTF-8 vs UTF-16.** We order strings by UTF-8 bytes (= code-point
   order). If Convex compares by UTF-16 code units, non-BMP characters mis-order relative to
   each other. Verify against the compatibility surface; a divergence here silently corrupts
   string-index cursors.
4. **Array/object index field values.** Out of scope in v1 (tags `0x06/0x07` reserved). Define
   their order-preserving encoding when schema support lands — nested-tuple escaping (a tuple
   inside a tuple) needs its own terminator discipline to keep prefix-correctness.
5. **Arbitrary-precision bigint.** Locked to Int64 (8 bytes) to match `v.int64()`;
   out-of-range throws. Confirm no app needs >64-bit values in an index key (a length+sign
   varint scheme would be the extension, but it complicates fixed-width assumptions).
6. **Read-set interval granularity for limited/paginated scans.** The codec supplies bytes;
   the *executor* decides whether `addIndexRange` records up to the last key examined (precise,
   avoids over-invalidating older pages) or to the requested bound. Pin this contract in the
   query-engine slice and test it — recording too wide over-invalidates at fan-out scale, too
   narrow misses invalidations.
7. **Format freeze / versioning.** Once the first DB is persisted or the first cursor issued,
   the byte format is a durable format. Decide a format-version strategy (a leading version
   byte on cursors? a docstore schema-version global?) and keep the golden-vector test as the
   tripwire, before declaring GA.
8. **hex vs base64url split.** `SerializedKeyRange` uses hex (debuggable, JSON-stable);
   cursors use base64url (compact, URL-safe). Confirm the client SDK and any JSON transport
   handle both and that cursor strings never need additional escaping.
