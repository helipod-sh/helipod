---
title: Foundation Component — Document Identity & Table Registry
slug: document-identity-registry
status: design (implementation-ready)
audience: engineering (internal)
slice: Foundation (Tier 0)
depends_on: [monorepo-tooling-skeleton]
seam_table_rows: [1, 2]
---

# Document Identity & Table Registry

> Clean-room design. We studied the `@concavejs/*` `.d.ts` shapes
> ([internals/01-storage](../internals/01-storage.md), [internals/04-query-engine](../internals/04-query-engine.md),
> [internals/06-runtimes-topology](../internals/06-runtimes-topology.md)) **only** to recover the
> handful of *interop facts* a Convex client depends on (the document-id wire format, the
> table-number reservations, the component-namespacing rule). Everything below is our own
> implementation design and original code intent. No FSL source is copied. See
> [`.reference/README.md`](../../../../.reference/README.md).

This component is the **identity bedrock** of the engine. Every document the system stores, every
id that crosses the wire to a client, and every routing decision a future sharded deployment makes
starts from the two facts this component owns: *what is this document's id* and *what table /
partition does it belong to*. It is small, pure, and load-bearing — get the codec or the
number-allocation wrong and corruption is silent and global, so the contracts here are exact and
the test bar (property tests) is high.

---

## 1. Purpose & boundaries

### 1.1 What it owns

1. **The developer-facing document-id codec.** The self-validating, Convex-compatible string id
   (`k57x3n8j…`) clients see, and its bidirectional conversion to/from the engine's internal
   `(tableNumber, internalId)` pair. Wire format:
   `Crockford-Base32( varint(tableNumber) ++ internalId[16] ++ fletcher16[2] )`. The three
   low-level codecs (Crockford Base32, Fletcher-16, varint) are owned here too.
2. **`InternalDocumentId`** — the engine's in-memory identity value `(tableNumber, internalId)` and
   its key/equality/hex helpers (used as `Map`/`Set` keys throughout the engine).
3. **The table registry** — the bidirectional mapping **name ↔ number ↔ component namespace**, with
   the system (`1–9999`) / user (`≥ 10001`) number bands, lazy user-number allocation, component
   namespacing (`fullName = componentPath + "/" + name`), per-component access checks, and the three
   variants: **in-memory** (dev/test), **DocStore-backed** (durable), and **transaction-bound**
   (read-your-writes table creation that commits atomically with the mutation that triggered it).
4. **The canonical `tableNumber → storage table_id / index_id` derivation.** The single place that
   decides "what opaque string names this table/index in the storage layer," so that convention
   lives in exactly one module instead of leaking across the engine.
5. **The partition / shard-key concept the data model carries.** The `ShardKey` type, the
   `ShardKeyResolver` interface, the Tier-0 `DefaultShardKeyResolver` (everything → `"default"`),
   and the registry's record of each table's *shard-key field*. This is the reserved hook for
   conversation = shard routing (scalability-spectrum seam-table **rows 1–2**).

### 1.2 What it explicitly does NOT own

| Concern | Owner |
|---|---|
| Physical SQLite schema (`documents`/`indexes`/`persistence_globals`), `DocStore` method impls | Storage adapter component ([internals/01](../internals/01-storage.md)) |
| The **order-preserving value/index-key codec** (`encodeIndexKey` over value tuples `null<bool<number<bigint<string<bytes`) | Query engine component ([internals/04](../internals/04-query-engine.md)) — *different codec, different job* (ordering, not identity) |
| OCC validation, the commit pipeline, `Transactor`, `TimestampOracle`, `CommitResult.shardId` threading | Transactor component ([internals/02](../internals/02-transactions-consistency.md)) — *consumes* our `ShardKey` |
| The actual `ShardRouter` (consistent/rendezvous hashing, coordinator, shard map) | Runtime-topology component (Tier 2, [internals/06](../internals/06-runtimes-topology.md)) — *consumes* our `ShardKey` |
| Schema definition / validators (`v.string()`…), schema → index lowering | Schema component |
| Reactive subscription matching, sync protocol, wire encoding | Sync component ([internals/03](../internals/03-reactivity-sync.md)) |

The boundary rule: **this component answers "who is this?" and "what partition is it in?"; other
components answer "where is it stored?", "what order is it in?", and "who is subscribed to it?"**

### 1.3 Position in the dependency graph

```
                         packages/id  (this component — pure, isomorphic, zero deps)
                              │
        ┌─────────────┬───────┴───────┬──────────────┬───────────────┐
        ▼             ▼               ▼              ▼               ▼
   packages/client  packages/codegen  storage      query-engine    transactor
   (validates ids)  (Id<"t"> types)   (table_id)   (db.get parse)  (CommitResult)
                                                                        │
   registry (TableRegistry + variants + ShardKeyResolver) lives in ─────┘
   packages/server/src/registry (consumes packages/id + the DocStore interface)
```

`packages/id` sits at the bottom: it has **no dependency on the storage layer, the engine, or any
runtime**, which is what lets the *client* import `isValidDocumentId`/`decodeDocumentId` and validate
ids with zero round-trips and zero server code in the bundle.

---

## 2. Concepts & data model

### 2.1 The two faces of an id

| | **Internal** (`InternalDocumentId`) | **Developer-facing** (`DocumentId` string) |
|---|---|---|
| Shape | `{ tableNumber: number, internalId: Uint8Array(16) }` | `"k57x3n8jg9q2w4e1r6t5y8u2i3o4p5a6"` |
| Where | inside the engine (storage keys, read sets, RYOW maps) | the wire, the client, generated `Id<"messages">` |
| Cost to make a `Map` key | `documentIdKey()` → `"10001:<hex>"` (no checksum) | the base32 string itself (carries a checksum) |
| Validatable offline? | n/a | **yes** — Fletcher-16 + structural checks, no DB |

**Decision (divergence from concave):** we drop concave's legacy dual hex-table-name representation.
`tableNumber` is the *single source of truth*; the storage `table_id` blob is **derived** from it
(`encodeStorageTableId`), never stored alongside a redundant hex name. This removes the
"two representations can disagree" class of bug ([internals/01 open question](../internals/01-storage.md#open-questions--risks)).

### 2.2 Byte layout of a document id

```
 byte 0..k-1      byte k..k+15            byte k+16..k+17
┌──────────────┬───────────────────────┬──────────────────┐
│ varint(table │  internalId (16 bytes │ Fletcher-16 over  │
│  Number)     │  CSPRNG randomness)   │ varint++internalId│
│  1..5 bytes  │                       │  2 bytes (BE)     │
└──────────────┴───────────────────────┴──────────────────┘
        └──────────── Crockford Base32 (unpadded) ─────────┘
                       → 31..37 chars
```

- The varint is **self-delimiting** (high-bit continuation), so the decoder finds the 16-byte
  `internalId` boundary without a length prefix.
- Total bytes = `varintLen(1..5) + 16 + 2` = **19..23 bytes** → **31..37** base32 chars.
- The checksum covers `varint(tableNumber) ++ internalId` (everything *before* the checksum), so a
  typo in either the table number or the random part is caught.

### 2.3 Table-number bands

```
 1 ──────────── 9999 │ 10000 │ 10001 ───────────────── 2^32-1
 └─ system / internal ┘  gap  └─ user tables (lazy, monotonic) ┘
```

- **System tables `1–9999`** are seeded at startup with fixed numbers (interop fact — clients and
  imported data assume them). `10000` is an intentional unused sentinel between the bands.
- **User tables start at `FIRST_USER_TABLE_NUMBER = 10001`**, allocated lazily on first reference and
  **never reused** (monotonic — deletion does not free a number; see §10).

### 2.4 Component namespace = isolation boundary

A table is identified by `(componentPath, name)`, where `componentPath` is `""` for the root app.
`fullName = componentPath === "" ? name : componentPath + "/" + name`. The **same `name` in two
components is two distinct `tableNumber`s** — this is the Convex component isolation boundary, and
(see §8.3) the *same* mechanism we reuse for multi-tenant shard scoping.

### 2.5 The shard / partition key

A `ShardKey` is the **logical partition key** a document belongs to — for a chat app, the
`conversationId`. It is *resolved from a document field* (declared per-table in the schema), not from
the random `internalId`, so that **all documents of one conversation share one `ShardKey`** and thus
co-locate. A `ShardId` is the **physical shard/committer** a `ShardKey` routes to. At Tier 0 every
`ShardKey` resolves to — and every `ShardId` is — the single constant `DEFAULT_SHARD = "default"`.

> **Invariant that makes Tier 0 → Tier 2 free:** a document id is **shard-agnostic**. The shard is
> *never* encoded into the id. Introducing real shards at Tier 2 therefore rewrites **zero** document
> ids, zero wire bytes, and zero app code — it only changes which `ShardId` a `ShardKey` maps to.

---

## 3. Public contracts (exact TypeScript)

All types below are the contracts other components compile against. Signatures are normative.

### 3.1 Constants

```ts
export const INTERNAL_ID_LENGTH = 16;          // bytes of CSPRNG randomness
export const FLETCHER16_LENGTH = 2;            // checksum bytes
export const MIN_ENCODED_LENGTH = 31;          // base32 chars, varint = 1 byte
export const MAX_ENCODED_LENGTH = 37;          // base32 chars, varint = 5 bytes

export const MIN_TABLE_NUMBER = 1;
export const MAX_TABLE_NUMBER = 0xffff_ffff;   // unsigned 32-bit
export const FIRST_SYSTEM_TABLE_NUMBER = 1;
export const LAST_SYSTEM_TABLE_NUMBER = 9999;
export const FIRST_USER_TABLE_NUMBER = 10001;  // 10000 is a reserved gap

export const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // omits i l o u

export const SYSTEM_TABLE_NUMBERS = {
  _tables: 1,
  _scheduled_functions: 2,
  _storage: 3,
  _crons: 4,
  _indexes: 5,
  _schemas: 6,
  _components: 7,
  _component_definitions: 8,
  _schema_validation_progress: 9,
} as const;

export const DEFAULT_SHARD: ShardId = "default";
```

### 3.2 Internal document identity

```ts
/** Raw 16-byte random component of a document id. Always length === INTERNAL_ID_LENGTH. */
export type InternalId = Uint8Array;

/** The engine's canonical in-memory identity for a document. tableNumber is the source of truth. */
export interface InternalDocumentId {
  readonly tableNumber: number;   // 1..2^32-1
  readonly internalId: InternalId; // 16 bytes
}

/** Stable, checksum-free string for use as a Map/Set key: `${tableNumber}:${hex(internalId)}`. */
export function documentIdKey(id: InternalDocumentId): string;
export function parseDocumentIdKey(key: string): InternalDocumentId;     // throws on malformed
export function documentIdsEqual(a: InternalDocumentId, b: InternalDocumentId): boolean;

/** Hex helpers (32 lowercase hex chars <-> 16 bytes). */
export function internalIdToHex(internalId: InternalId): string;
export function hexToInternalId(hex: string): InternalId;                // throws if length !== 32
```

### 3.3 The document-id codec (the named contracts)

```ts
/** Branded developer-facing id string. Structurally a string; brand prevents accidental misuse. */
export type DocumentId = string & { readonly __brand: "DocumentId" };

/** Encode (tableNumber, internalId) -> developer-facing id. Throws RangeError on bad inputs. */
export function encodeDocumentId(tableNumber: number, internalId: InternalId): DocumentId;

/** Convenience overload over the struct. */
export function encodeInternalDocumentId(id: InternalDocumentId): DocumentId;

/** Decode a developer-facing id. Throws DocumentIdError on malformed / bad-checksum input. */
export function decodeDocumentId(encoded: string): InternalDocumentId;

/** Non-throwing decode. Returns null instead of throwing. */
export function tryDecodeDocumentId(encoded: string): InternalDocumentId | null;

/**
 * Structural + checksum validation with NO registry round-trip.
 * If expectedTableNumber is given, also asserts the decoded table matches.
 */
export function isValidDocumentId(encoded: string, expectedTableNumber?: number): boolean;

/** 16 fresh bytes from the platform CSPRNG (crypto.getRandomValues). */
export function generateInternalId(): InternalId;

/** Allocate a brand-new id for a table (generateInternalId + struct). */
export function newDocumentId(tableNumber: number): InternalDocumentId;

/** Predict the encoded length for a table number (for buffer sizing / tests). */
export function getEncodedLength(tableNumber: number): number; // 31..37

export class DocumentIdError extends Error {
  readonly kind: "length" | "charset" | "varint" | "checksum" | "table-range";
  readonly input: string;
}
```

### 3.4 Low-level codecs (owned here, individually testable)

```ts
// ── Crockford Base32 (unpadded, big-endian bit packing, order-preserving) ──────────────
export function base32Encode(bytes: Uint8Array): string;
export function base32Decode(text: string): Uint8Array;  // case-insensitive; throws on bad char / non-canonical padding bits
export function isValidBase32(text: string): boolean;

// ── Fletcher-16 (mod 255) ──────────────────────────────────────────────────────────────
export function fletcher16(bytes: Uint8Array): number;            // 0..65535
export function verifyFletcher16(bytes: Uint8Array, checksum: number): boolean;

// ── Unsigned LEB128 varint over uint32 (canonical form enforced) ─────────────────────────
export function varintEncode(value: number): Uint8Array;          // 1..5 bytes; throws if out of uint32 range
export function varintDecode(bytes: Uint8Array, offset?: number): { value: number; bytesRead: number };
export function varintEncodedLength(value: number): number;       // 1..5
```

### 3.5 Storage-key derivation (tableNumber → opaque storage namespace)

```ts
/**
 * The canonical, stable string that names a table's keyspace in the storage layer
 * (the `table_id` blob). Derived solely from tableNumber so the engine never needs a
 * second representation. Stable across processes and restarts.
 */
export function encodeStorageTableId(tableNumber: number): string;
export function decodeStorageTableId(tableId: string): number;

/** The storage `index_id` for a (table, indexName). The query engine fills the index *keys*; we name the index. */
export function encodeStorageIndexId(tableNumber: number, indexName: string): string;
export function decodeStorageIndexId(indexId: string): { tableNumber: number; indexName: string };
```

`encodeStorageTableId` is a pure, total function (e.g. an unambiguous prefixed encoding such as
`"t" + base32(varint(tableNumber))`); the exact spelling is an internal convention, but it MUST be
collision-free across all `tableNumber`s and stable forever once data exists. (See §10 open issue on
locking the spelling before first durable write.)

### 3.6 Table registry

```ts
export type TableVisibility = "user" | "system";
export type TableState = "active" | "creating" | "deleting"; // "creating"/"deleting" reserved for async DDL; Foundation only emits "active"

export interface TableInfo {
  readonly tableNumber: number;
  readonly name: string;            // logical, e.g. "messages"
  readonly componentPath: string;   // "" for the root app
  readonly fullName: string;        // componentPath==="" ? name : `${componentPath}/${name}`
  readonly isSystem: boolean;       // tableNumber <= LAST_SYSTEM_TABLE_NUMBER
  readonly visibility: TableVisibility;
  readonly state: TableState;
  readonly createdAt: number;       // Unix ms (display/audit). Durable variant also has the MVCC ts on its _tables row.
  readonly shardKeyField?: string;  // schema-declared partition field (e.g. "conversationId"); undefined => DEFAULT_SHARD
}

export interface AllocateOptions {
  shardKeyField?: string;
  visibility?: TableVisibility;     // default "user" for >=10001, "system" otherwise
}

export interface TableRegistry {
  /**
   * Idempotently return the table number for (name, componentPath), allocating a fresh
   * user number (>= 10001) on first reference. Async because the durable/transactional
   * variants persist the new mapping. Concurrent allocations of the same name converge to
   * one number (memory: lock; durable/txn: OCC, see §6.4).
   */
  getOrAllocateTableNumber(name: string, componentPath?: string, opts?: AllocateOptions): Promise<number>;

  /** Cache-backed synchronous lookups (see §6.3 on cross-process freshness). */
  getTableInfo(tableNumber: number): TableInfo | undefined;
  getTableInfoByName(name: string, componentPath?: string): TableInfo | undefined;
  listTables(componentPath?: string): TableInfo[];

  /** Access control: a component may touch only its own tables + system tables. */
  hasAccess(tableNumber: number, componentPath: string): boolean;

  /** Fixed system-table lookup by name (e.g. "_scheduled_functions" -> 2). */
  getSystemTableNumber(name: string): number | undefined;

  /** The partition field declared for a table, if any (drives ShardKeyResolver at Tier 2). */
  getShardKeyField(tableNumber: number): string | undefined;

  /** Force a re-read of durable metadata (durable variant); no-op for memory. */
  refresh(): Promise<void>;
}
```

#### Name helpers (free functions)

```ts
export function getFullTableName(name: string, componentPath: string): string;
export function parseFullTableName(fullName: string): { name: string; componentPath: string };
export function isSystemTable(tableNumber: number): boolean;       // tableNumber <= 9999
export function isSystemTableName(name: string): boolean;          // name.startsWith("_")
```

#### The three variants

```ts
/** Pure in-memory map. Seeds system tables, hands out user numbers from a counter. Dev/test/Tier-0-ephemeral. */
export class MemoryTableRegistry implements TableRegistry {
  constructor(opts?: { seedSystemTables?: boolean }); // default true
}

/**
 * Durable registry: the mapping is persisted as rows in the `_tables` system table *through the
 * DocStore itself*, with an in-memory cache + freshness TTL so lookups don't hit storage every call.
 * This is the production Tier-0 (and beyond) registry.
 */
export class DocStoreTableRegistry implements TableRegistry {
  constructor(store: DocStore, oracle: TimestampOracle, opts?: { cacheTtlMs?: number /* default 5000 */ });
  /** Read the _tables table at startup and prime the cache; advances nothing if empty (then bootstraps system rows). */
  init(): Promise<void>;
}

/**
 * Binds a base registry to an in-flight OCC mutation so that table allocations made *inside* the
 * transaction are (a) visible to later reads in the same transaction (read-your-writes) and
 * (b) committed atomically with the mutation — or discarded entirely on rollback.
 */
export class TransactionalTableRegistry implements TableRegistry {
  constructor(base: TableRegistry, txn: TableAllocationTxn);
  /** Pending allocations staged in this txn but not yet committed. */
  pendingAllocations(): ReadonlyArray<TableInfo>;
}

export function createTransactionalTableRegistry(
  base: TableRegistry,
  txn?: TableAllocationTxn,    // when omitted, returns `base` unchanged (non-transactional path)
): TableRegistry;

/** The minimal surface the transactional registry needs from the transactor (avoids a server<-server cycle). */
export interface TableAllocationTxn {
  readonly snapshotTimestamp: bigint;
  /** Stage a new `_tables` row; becomes visible to this txn's reads, applied on commit. */
  stageTableRow(info: TableInfo): void;
  /** Record that the allocation read the current high-water mark / name index (for OCC validation). */
  recordAllocationRead(name: string, componentPath: string): void;
}
```

### 3.7 Shard key & resolver (the reserved scale seam)

```ts
/** Logical partition key a document belongs to (e.g. a conversationId). "default" at Tier 0. */
export type ShardKey = string;

/** Physical shard / committer id a ShardKey routes to. "default" at Tier 0. */
export type ShardId = string;

export interface ShardKeyResolverInput {
  readonly tableNumber: number;
  readonly componentPath: string;
  readonly documentId: InternalDocumentId;
  readonly document: Record<string, unknown>; // the doc body, to read the shard-key field
}

/** Resolves the logical partition key for a document about to be written. Pure & synchronous. */
export interface ShardKeyResolver {
  resolveShardKey(input: ShardKeyResolverInput): ShardKey;
}

/** Tier 0: every document is in the single local shard. Never throws. */
export class DefaultShardKeyResolver implements ShardKeyResolver {
  resolveShardKey(): ShardKey { return DEFAULT_SHARD; }
}

/**
 * Tier-2-ready: reads the schema-declared shard-key field from the document. Declared here (the
 * owner of the concept) but only *wired in* when a sharded deployment is configured. At Tier 0 the
 * runtime installs DefaultShardKeyResolver instead.
 */
export class FieldShardKeyResolver implements ShardKeyResolver {
  constructor(registry: TableRegistry, opts?: { scopeByComponent?: boolean });
  resolveShardKey(input: ShardKeyResolverInput): ShardKey;
}
```

The **downstream Tier-2 consumer** (defined in the runtime-topology component, *not* here) closes the
loop:

```ts
// runtime-topology component (Tier 2) — shown for context; consumes our ShardKey/ShardId.
interface ShardRouter<TStub = unknown> {
  getShardForDocument(id: InternalDocumentId, shardKey: ShardKey): ShardId; // consistent-hash(shardKey)
  getCommitterStub(shardId: ShardId): TStub;
  // ...client→sync-node rendezvous hashing, etc.
}
```

---

## 4. Key algorithms

### 4.1 `encodeDocumentId(tableNumber, internalId)`

```
assert 1 <= tableNumber <= 2^32-1            else RangeError (kind "table-range")
assert internalId.length === 16              else RangeError
v   := varintEncode(tableNumber)             // 1..5 bytes, canonical
body:= v ++ internalId                       // 17..21 bytes
ck  := fletcher16(body)                      // 16-bit, mod-255
out := body ++ [ (ck >> 8) & 0xff, ck & 0xff ]   // big-endian checksum → 19..23 bytes
return base32Encode(out)                     // 31..37 chars
```

### 4.2 `decodeDocumentId(encoded)` / `isValidDocumentId(encoded)`

```
1. length gate:  31 <= encoded.length <= 37      else DocumentIdError("length")
2. bytes := base32Decode(encoded.toLowerCase())  // throws "charset" on bad char / non-canonical bits
3. len gate on bytes: 19 <= bytes.length <= 23   else "length"
4. {value:tableNumber, bytesRead:k} := varintDecode(bytes, 0)   // throws "varint" on overlong/overflow
5. assert bytes.length === k + 16 + 2            else "length"
6. body := bytes[0 .. k+16);  ck := (bytes[k+16] << 8) | bytes[k+17]
7. assert verifyFletcher16(body, ck)             else "checksum"
8. internalId := bytes[k .. k+16)
9. assert 1 <= tableNumber <= 2^32-1             else "table-range"
return { tableNumber, internalId }
```

`isValidDocumentId` runs the same pipeline and returns `false` on any failure (never throws); with
`expectedTableNumber` it also checks step 9 against the expectation. **No registry is consulted** — a
client can validate an id offline; whether the `tableNumber` actually *exists* is a separate
registry lookup the server does later.

### 4.3 Crockford Base32 (unpadded, order-preserving)

- **Encode:** pack bytes MSB-first into 5-bit groups; map each group through `CROCKFORD_ALPHABET`;
  no `=` padding. Output length = `ceil(8·n / 5)`.
- **Decode:** lower-case the input; map each char back to 5 bits (reject any char not in the
  alphabet — we do **not** apply Crockford's lenient `i/l→1`, `o→0` substitutions; see §7); the byte
  length is `floor(5·len / 8)`; **reject if the trailing `<8` leftover bits are non-zero** (enforces a
  single canonical encoding, so two strings can't decode to the same bytes).
- **Order-preserving:** because packing is MSB-first and the alphabet is in ASCII-ascending order,
  `byteCompare(a, b) === stringCompare(base32(a), base32(b))` for equal-length inputs. (Caveat:
  across *different* table numbers the varint length differs, so full-id string order is **not**
  numeric `tableNumber` order — ids are identity, not a sort key. Within one table, id string order
  equals `internalId` byte order. Both facts are property-tested.)

### 4.4 Fletcher-16 (mod 255)

```
sum1 = 0; sum2 = 0
for b in bytes: sum1 = (sum1 + b) % 255; sum2 = (sum2 + sum1) % 255
return (sum2 << 8) | sum1
```

Detects **all single-byte errors** and most two-byte transpositions — the integrity guarantee that
makes a truncated/mistyped id fail fast at `decodeDocumentId` instead of silently resolving to a
different (or absent) document. This is *integrity, not security*: ids are not secret, just
self-checking.

### 4.5 Unsigned LEB128 varint (canonical)

- **Encode:** emit 7 bits/byte, little-endian groups, high bit = "more"; 1 byte for `0–127`, up to 5
  bytes for `2^32-1`.
- **Decode:** accumulate 7-bit groups until a byte with the high bit clear; **reject overlong
  encodings** (a value that could have fit in fewer bytes) and **reject > 5 bytes / > 2^32-1** — both
  raise `DocumentIdError("varint")`. Canonical form is required so each `tableNumber` has exactly one
  valid id encoding (otherwise the checksum and id-equality lose meaning).

### 4.6 Lazy user-number allocation

Allocation is just "insert a row into `_tables`," reusing the engine's own machinery:

```
getOrAllocateTableNumber(name, componentPath="", opts):
  full := getFullTableName(name, componentPath)
  if cache.byFullName has full: return its number          // idempotent fast path
  if isSystemTableName(name): return getSystemTableNumber(name) ?? error  // never auto-allocate "_x"
  n := max(highWaterMark, FIRST_USER_TABLE_NUMBER - 1) + 1  // next user number
  info := { tableNumber:n, name, componentPath, fullName:full, isSystem:false,
            visibility: opts.visibility ?? "user", state:"active",
            createdAt: Date.now(), shardKeyField: opts.shardKeyField }
  persist(info)                                             // variant-specific (§6)
  cache.put(info); highWaterMark = n
  return n
```

- **Memory variant:** `persist` = update the local maps under a synchronous critical section; the
  counter makes collisions impossible in one process.
- **Durable variant:** `persist` = `DocStore.write` a `_tables` row at a fresh commit ts; the
  high-water mark is recovered on `init()` as `max(tableNumber)` over `_tables` (or
  `FIRST_USER_TABLE_NUMBER-1` if empty), then bootstraps the 9 system rows via
  `writeGlobalIfAbsent`-guarded one-time seeding.
- **Transactional variant:** §6.4.

### 4.7 Transactional allocation = read-your-writes + OCC (the correctness crux)

```
TransactionalTableRegistry.getOrAllocateTableNumber(name, cp, opts):
  full := getFullTableName(name, cp)
  if staged.byFullName has full: return staged number            // RYOW within this txn
  if base.getTableInfoByName(name, cp): return that number       // already durable
  txn.recordAllocationRead(name, cp)        // OCC: we depend on "no row for `full` exists yet"
  n := max(base.highWaterMark, max(staged numbers), FIRST_USER_TABLE_NUMBER-1) + 1
  info := {…, createdAt: Date.now()}
  staged.put(info)                          // visible to this txn only
  txn.stageTableRow(info)                   // applied iff the mutation commits
  return n
```

- **Reads in the same transaction** see staged allocations (RYOW) because lookups consult `staged`
  before `base`.
- **On commit**, the staged `_tables` rows are written atomically with the mutation's other writes at
  the single commit ts; the base registry's cache is then updated (or simply invalidated to re-read).
- **On rollback / conflict**, `staged` is discarded and the base cache is **never** touched — a
  rolled-back allocation must not leak a phantom number into the process-wide registry.
- **OCC for concurrent allocation of the same new name:** both transactions `recordAllocationRead`
  the absence of `full`; the first to commit writes the `_tables` row; the second's commit-time OCC
  validation sees that the name-index range it read (absence of `full`) now has a row → `ConflictError`
  → the caller replays the deterministic mutation → on replay the name now resolves via `base` to the
  already-committed number. Result: **one number, no duplicate, no lost table.** This is the OCC
  conflict case in the test plan (§9.4).

### 4.8 Shard resolution

```
DefaultShardKeyResolver.resolveShardKey(_)              → "default"     // Tier 0
FieldShardKeyResolver.resolveShardKey(input):                            // Tier 2-ready
  field := registry.getShardKeyField(input.tableNumber)
  if !field: return DEFAULT_SHARD
  key := String(input.document[field] ?? "")            // the conversationId value
  return opts.scopeByComponent ? `${input.componentPath} ${key}` : key
```

The resolver returns only the *logical* `ShardKey`; mapping `ShardKey → ShardId` (consistent hashing)
is the Tier-2 `ShardRouter`'s job. At Tier 0 the write path calls the resolver, gets `"default"`, and
threads `DEFAULT_SHARD` as the `shardId` everywhere — exercising the exact code path Tier 2 uses, with
a constant value.

---

## 5. Package / module / file layout

```
packages/id/                         # NEW top-level package — pure, isomorphic (browser+Node), zero deps
  package.json                       #   "type":"module", exports map, no deps; sideEffects:false (tree-shakeable)
  src/
    base32.ts                        # base32Encode / base32Decode / isValidBase32  (+ CROCKFORD_ALPHABET)
    fletcher16.ts                    # fletcher16 / verifyFletcher16
    varint.ts                        # varintEncode / varintDecode / varintEncodedLength
    document-id.ts                   # encodeDocumentId / decodeDocumentId / isValidDocumentId /
                                     #   tryDecodeDocumentId / generateInternalId / newDocumentId /
                                     #   getEncodedLength / DocumentId / DocumentIdError / constants
    internal-document-id.ts          # InternalDocumentId / InternalId / documentIdKey /
                                     #   parseDocumentIdKey / documentIdsEqual / hex helpers
    storage-keys.ts                  # encodeStorageTableId/IndexId (+ decoders)
    shard.ts                         # ShardKey / ShardId / DEFAULT_SHARD / ShardKeyResolver /
                                     #   ShardKeyResolverInput / DefaultShardKeyResolver
    index.ts                         # barrel
  test/
    base32.prop.test.ts  fletcher16.test.ts  varint.prop.test.ts
    document-id.prop.test.ts  document-id.test.ts  shard.test.ts

packages/server/src/registry/        # the registry (engine concern; depends on packages/id + DocStore iface)
  table-info.ts                      # TableInfo / TableVisibility / TableState / SYSTEM_TABLE_NUMBERS /
                                     #   FIRST_USER_TABLE_NUMBER / name helpers / isSystemTable
  table-registry.ts                  # TableRegistry interface + AllocateOptions
  memory-table-registry.ts           # MemoryTableRegistry
  docstore-table-registry.ts         # DocStoreTableRegistry (consumes DocStore, TimestampOracle)
  transactional-table-registry.ts    # TransactionalTableRegistry / createTransactionalTableRegistry /
                                     #   TableAllocationTxn
  field-shard-key-resolver.ts        # FieldShardKeyResolver (Tier-2-ready; needs the registry)
  index.ts
  test/
    memory-registry.test.ts  docstore-registry.test.ts  transactional-registry.test.ts
```

**Why a separate `packages/id`:** the client and codegen must validate/handle ids (`isValidDocumentId`,
`Id<"t">`) with **no** server/storage code in the bundle. Keeping the codec dependency-free and
isomorphic is what enables client-side, round-trip-free validation. The *registry* (allocation,
durability, access control) is an engine concern, so it lives in `packages/server` and is never shipped
to the browser. `FieldShardKeyResolver` lives with the registry (it needs `getShardKeyField`);
`DefaultShardKeyResolver` lives in `packages/id` because it is pure and Tier 0 wires it in everywhere.

This honors CLAUDE.md's package list (only one new small, single-purpose package) and the "engine never
imports a driver" rule (the registry talks to the abstract `DocStore`, never SQLite).

---

## 6. Tier 0 — how it works NOW (single binary)

1. **Dev / ephemeral:** `stackbase dev` with an in-memory or throwaway DB uses
   `MemoryTableRegistry` — system tables seeded, user numbers from a counter, instant, no persistence.
2. **Durable single binary:** the `EmbeddedRuntime` constructs `DocStoreTableRegistry` over the same
   SQLite `DocStore` the rest of the engine uses; `init()` reads `_tables`, recovers the high-water
   mark, and bootstraps the 9 system rows once. A 5 s cache TTL keeps lookups in-process and cheap.
3. **Every mutation** that inserts into a not-yet-seen table wraps the base registry with
   `createTransactionalTableRegistry(base, txn)`, so the new table's `_tables` row commits atomically
   with the inserted document — a developer never observes "table half-created."
4. **One shard.** The runtime installs `DefaultShardKeyResolver`. The write path resolves every
   document to `DEFAULT_SHARD`, and `shardId = "default"` threads through `DocStore.write(...)`, the
   `Transactor`, `TimestampOracle`, `CommitResult`, and `WriteInvalidation` — the seam is *present and
   exercised*, just constant.
5. **Ids are final.** `encodeDocumentId`/`decodeDocumentId` produce the exact same bytes they will at
   Tier 2 (ids are shard-agnostic), so data and clients created on a laptop keep working verbatim on a
   sharded fleet.

There is **no Tier-2 code on the Tier-0 hot path** — only the *interfaces* (`ShardKey`,
`ShardKeyResolver`, the `shardId` parameter) are in place, with trivial implementations.

---

## 7. The scale seam — how WhatsApp-scale attaches later with NO rewrite

This component delivers scalability-spectrum **seam-table rows 1–2** (the data-model half of the
non-negotiable "conversation = shard → single-writer-per-shard" mandate). The other half (the
per-shard transactor/oracle, `CommitResult.shardId`, and the `ShardRouter` itself) is delivered by the
transactor and topology components, which *consume* the types defined here.

| Seam row | Tier-0 reality (now) | Tier-2 realization (later, drop-in) | What this component reserves |
|---|---|---|---|
| **1 — unbounded write throughput** | one shard, `shardId="default"` threaded everywhere | `ShardRouter.getShardForDocument(id, shardKey)` consistent-hashes the `ShardKey` → per-conversation committer; throughput scales linearly with shard count | the `ShardKey`/`ShardId` types + `DEFAULT_SHARD`; the shard-agnostic id codec; `TableInfo.shardKeyField` |
| **2 — write co-location** | `DefaultShardKeyResolver` → `"default"` | swap to `FieldShardKeyResolver`: reads the schema's `shardKeyField` (e.g. `conversationId`) so all of a conversation's docs share one `ShardKey` and co-locate on one writer | `ShardKeyResolver` interface + `getShardKeyField` on the registry |

### 7.1 Why it is a drop-in, not a rewrite

- **App code is untouched.** The schema's `conversationId` field already exists; declaring it the
  shard key is config/schema metadata (`shardKeyField`), not an app change. No `convex/` function, no
  `useQuery`, no document id changes.
- **The write path already passes `shardId`.** Promoting Tier 0 → Tier 2 swaps two *implementations*
  behind stable interfaces — `DefaultShardKeyResolver → FieldShardKeyResolver` and the no-op
  router → consistent-hash `ShardRouter` — and nothing else on the engine path changes.
- **Ids never move.** Because the shard is not encoded in the id (§2.5 invariant), resharding rewrites
  zero ids and zero wire bytes. A document minted at Tier 0 routes correctly at Tier 2 purely by
  re-resolving its `ShardKey` from its (unchanged) body field.

### 7.2 Component namespacing = the same isolation boundary, reused for multi-tenancy

`fullName = componentPath + "/" + name` already gives every component its own `tableNumber` space and
its own `hasAccess` boundary. That *same* mechanism is the multi-tenant shard-scoping hook: model a
tenant as a namespace (component path) and set `FieldShardKeyResolver({ scopeByComponent: true })`, so
the resolved `ShardKey` is `componentPath   conversationId`. Tenants then partition across shards
with zero cross-tenant write contention — the isolation boundary we built for Convex components doubles
as the tenant boundary, with no new concept. Tier 0 collapses all of it to `"default"`.

---

## 8. Failure & edge handling

### 8.1 Codec

| Case | Behavior |
|---|---|
| Length `< 31` or `> 37` | reject before decode → `DocumentIdError("length")` / `isValid → false` |
| Char not in Crockford alphabet (incl. `i l o u`, `-`, whitespace) | `DocumentIdError("charset")`. **Strict**: we do *not* apply lenient `i/l→1`, `o→0` (a typo must fail, not silently remap to another id). Case is normalized (lower) — that is safe. |
| Non-canonical base32 (non-zero leftover padding bits) | rejected (`charset`) — keeps id↔bytes bijective |
| Overlong / `>5`-byte / `>2^32-1` varint | `DocumentIdError("varint")` |
| Byte length ≠ `varintLen + 16 + 2` | `DocumentIdError("length")` |
| Checksum mismatch (truncation, single-byte typo, most transpositions) | `DocumentIdError("checksum")` |
| `tableNumber` decodes but is **not registered** | codec **succeeds** (structure is valid); the *registry* lookup returns `undefined`; the caller maps that to a 404 / access error. Codec never needs the registry. |
| `encode` with `tableNumber ∉ [1, 2^32-1]` or `internalId.length ≠ 16` | `RangeError` (`table-range` / generic) — programmer error |
| CSPRNG unavailable | `generateInternalId` throws at startup (fail fast); no insecure fallback |

### 8.2 Registry

| Case | Behavior |
|---|---|
| Allocate an existing `(name, componentPath)` | idempotent — returns the existing number |
| Auto-allocating a `_`-prefixed name | refused; system tables are seeded, never lazily created |
| Cross-component access (`hasAccess(otherTablesNumber, myPath)`) | `false`; the engine throws an access error before touching storage. System tables are readable by all. |
| Concurrent allocation, same new name (durable/txn) | OCC: one commits, the other gets `ConflictError` and converges on replay (§4.7) |
| Concurrent allocation, different names | independent → two distinct numbers, no conflict |
| Transaction rollback after staging an allocation | staged rows discarded; base cache untouched (no phantom number) |
| User-band exhaustion (`> 2^32-1`) | allocation throws (astronomically unreachable; documented) |
| System-band overflow (`> 9999` system tables) | static error at bootstrap (we define 9; the band holds 9999) |
| Lookup of a table created by *another* process within the TTL window (Tier 1+) | sync lookup may miss until `refresh()`/TTL; mitigations & open issue in §10 |

### 8.3 Shard

`resolveShardKey` is **total and never throws**: a missing/`null` shard-key field yields `DEFAULT_SHARD`
(degrades to single-shard for that doc rather than failing a write). At Tier 0 the resolver is constant,
so this path is inert.

---

## 9. Test strategy

The codec is the highest-risk surface (silent, global corruption if wrong), so property tests are the
**acceptance gate**, mirroring the order-preserving-codec discipline the query engine uses.

### 9.1 Codec — unit (known-answer)

- Fixed vectors for `base32Encode/Decode`, `fletcher16` (hand-computed), `varintEncode/Decode` at the
  boundaries `0, 127, 128, 16383, 16384, 2^32-1`.
- `encodeDocumentId` length table: tableNumber `1, 9, 10001, 127, 128, 2^14, 2^21, 2^28, 2^32-1` →
  assert encoded length ∈ `[31, 37]` and equals `getEncodedLength(tableNumber)`.
- At least one **golden Convex id** captured from a real Convex/`convex-js` instance must
  `decodeDocumentId` to the expected `(tableNumber, internalId)` and re-`encode` byte-identically —
  this is the interop gate (see §10 open issue #1).

### 9.2 Codec — property (fast-check)

1. **Round-trip:** ∀ `tableNumber ∈ [1, 2^32-1]`, `internalId ∈ bytes[16]`:
   `decodeDocumentId(encodeDocumentId(t, id))` deep-equals `{ t, id }`.
2. **Validation totality:** ∀ valid id `s`, `isValidDocumentId(s) === true`; ∀ arbitrary string,
   `isValidDocumentId` never throws and `tryDecode` agrees with `decode`'s throw/return.
3. **Single-byte detection (Fletcher guarantee):** ∀ id, for *every* byte position and *every*
   alternate value, mutating one byte of the pre-base32 buffer → `verifyFletcher16` fails (exhaustive
   over positions for sampled ids; this is the property that makes "self-validating" true).
4. **Single-char typo rejection:** ∀ id, flipping any one base32 char to another alphabet char →
   `isValidDocumentId === false` with overwhelming probability (assert ≥ a high threshold over a large
   sample; document that Fletcher-16 is not a 100% guarantee at the *char* level, only at the byte
   level).
5. **Base32 order-preservation:** ∀ equal-length byte arrays `a, b`:
   `sign(byteCompare(a,b)) === sign(stringCompare(base32(a), base32(b)))`. Plus: ∀ fixed `tableNumber`,
   id-string order equals `internalId` byte order.
6. **Varint canonicality & prefix-freeness:** ∀ `n ∈ uint32`: `varintDecode(varintEncode(n)).value === n`;
   decoding succeeds with arbitrary **trailing** bytes and reports the correct `bytesRead`; overlong
   encodings are rejected.
7. **Base32 canonicality:** decoding a string with non-zero leftover padding bits is rejected; no two
   distinct strings decode to the same bytes.

### 9.3 Registry — unit

- System tables seeded with the exact numbers `_tables=1 … _schema_validation_progress=9`;
  `getSystemTableNumber` and `getTableInfo` agree.
- First user allocation `=10001`, then `10002, …`, monotonic; re-allocating a name is idempotent.
- Namespace isolation: same `name` under `""` vs `"waitlist"` → two different numbers; `hasAccess`
  allows own + system, denies cross-component.
- `getFullTableName`/`parseFullTableName` round-trip incl. names containing slashes-in-component edge.
- `shardKeyField` recorded at allocation and returned by `getShardKeyField`.

### 9.4 Registry — durable & transactional (the OCC/RYOW cases the spec calls out)

- **Durability round-trip:** allocate via `DocStoreTableRegistry`, drop the cache, `init()` a fresh
  registry over the same `DocStore` → identical mapping and high-water mark recovered.
- **TTL refresh:** a second registry over the same store picks up an externally-added `_tables` row
  after `refresh()` / TTL expiry.
- **RYOW:** inside a `TransactionalTableRegistry`, allocate `"messages"` → `getTableInfoByName("messages")`
  returns the staged number *before* commit; `base` does **not** yet see it.
- **Commit:** after the mutation commits, `base` now returns the same number; the `_tables` row exists
  at the mutation's commit ts.
- **Rollback (critical):** stage an allocation, then roll back → `base` still has **no** such table;
  `pendingAllocations()` is empty; no phantom number burned.
- **OCC conflict (critical):** two transactions concurrently allocate the same new name against one
  base store; drive both through stage → commit. Assert exactly one commits, the other throws
  `ConflictError`; on deterministic replay the loser resolves the **already-committed** number →
  **one** number, **no** duplicate `_tables` row, **no** lost table.
- **No-conflict concurrency:** two transactions allocating *different* names both commit → two distinct
  numbers, no `ConflictError`.

### 9.5 Shard seam

- `DefaultShardKeyResolver.resolveShardKey(anything) === "default"` (Tier-0 invariant).
- `FieldShardKeyResolver` reads the declared field; missing field → `DEFAULT_SHARD`; `scopeByComponent`
  prefixes the component path.
- **Seam-preservation test:** for a fixed document, swapping `Default → Field` resolver changes the
  resolved `ShardKey` but leaves `encodeInternalDocumentId(doc.id)` **byte-identical** — proving the id
  (and thus app code and wire) is shard-agnostic (§2.5 invariant).

---

## 10. Open issues

1. **Convex interop must be byte-verified, not assumed (highest priority).** "Convex clients parse and
   validate these strings," so our Crockford alphabet, our **checksum algorithm/byte order**, and our
   **varint** must match Convex's *exactly*. Capture real ids from `convex-js`/`convex-backend` and add
   them as golden vectors (§9.1) before locking the format. If Convex's checksum differs from
   Fletcher-16-mod-255-big-endian, this component's wire format changes here and nowhere else — which is
   the point of isolating it.
2. **Lock `encodeStorageTableId`'s spelling before the first durable write.** Once data exists, the
   `tableNumber → table_id` string is frozen forever (it is embedded in every stored row's key). Decide
   and freeze the exact encoding (and confirm the storage layer and query-engine `RangeSet`
   `table:`/`index:` namespacing consume it, not a parallel convention) before any non-test DB is
   written.
3. **Strict vs lenient Crockford decode.** We chose **strict** (reject `i/l/o/u`, no remap) for
   self-validation. Confirm no legitimate inbound id (e.g. a hand-shared deep link) relies on lenient
   decoding; if product wants lenient *input*, gate it behind an explicit `normalizeCrockford()` step
   that runs *before* checksum verification, never inside `decodeDocumentId`.
4. **Cross-process registry cache coherence (Tier 1+).** Sync `getTableInfo*` serve a TTL cache; a table
   created in process A is briefly invisible in process B. Tier 0 (one process) is unaffected. For the
   multi-embedded-process step, decide the fix: push `_tables` invalidations over the existing
   `WriteFanout` (preferred — reuses seam-table row 4), shorten the TTL, or make the *allocation* path
   (already async/authoritative) the only one that must be fresh. Pick before Tier 1.
5. **`createdAt` semantics.** Currently Unix ms for display. The durable `_tables` row also carries the
   MVCC commit ts; decide whether `TableInfo.createdAt` should surface the logical ts instead for audit
   determinism (wall clock is non-monotonic across restarts).
6. **Table deletion / number reuse.** Numbers are monotonic and never reused (a deleted table's number
   stays retired) to keep historical ids unambiguous. Confirm this is acceptable vs. a `state:"deleting"`
   tombstone + eventual GC policy; either way `state` is reserved in `TableInfo` for it.
7. **`shardKeyField` provenance.** It must come from validated schema metadata (a `.shardKey(field)`
   builder or a documented convention), not be guessed. Define the schema-component contract that feeds
   it; until then Tier 0 leaves it `undefined` (→ `DEFAULT_SHARD`) and nothing depends on it.
8. **`TableState` machine for async DDL.** `"creating"/"deleting"` are reserved but unused in
   Foundation (allocation is atomic-within-mutation, so tables appear `"active"`). Specify the state
   transitions if/when background table builds (e.g. large index backfills) land.
