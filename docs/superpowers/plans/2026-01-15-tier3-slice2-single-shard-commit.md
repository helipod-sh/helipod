# Tier 3 Slice 2 — Single-shard commit over object storage (implementation plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the whole-arc plan
> (`2026-01-15-tier3-object-storage-substrate.md`), the design record, and the interface map from the
> Slice-1 handoff. Slice 1 (`@stackbase/objectstore` seam + fs/s3 adapters) is shipped.

**Goal:** one writer commits durably to a bucket (no Postgres), and a second process materializes the
IDENTICAL state by replaying the object-storage log. Single node, single shard, no snapshots yet
(bootstrap = full log). Proves the substrate's core: local-materialized reads/OCC + segment-append +
manifest-CAS commit.

**Architecture (the load-bearing design decisions, from the interface map):**
- `ObjectStoreDocStore` is a **decorator** over a local `SqliteDocStore` + an `ObjectStore` (one shard).
  It **forwards all reads** (`get`/`scan`/`count`/`maxTimestamp`/`getGlobal`/client-verdict/…) to the
  local store, and **intercepts only `commitWrite`/`commitWriteBatch`**.
- **Commit is OBJECT-FIRST** (object storage is the linearization point; the local store never gets
  ahead of the durable log): allocate `ts` from the manifest → build a segment → `putImmutable` →
  `casPut(manifest)` (the fence) → on CAS conflict throw `FencedError` (nothing applied locally) → on
  success apply the batch to the local store via `write(stampedDocs, stampedIdx, "Overwrite")` (the
  explicit-ts path the replica-tailer uses) → return the ts array.
- **Bootstrap** = replay every segment `(0, frontierTs]` into a fresh local store via the same
  `write("Overwrite")` path, with a density check; the local `maxTimestamp()` is the resumable
  watermark (mirrors `ReplicaTailer`).
- The transactor's `WrittenDoc`/fan-out is UNTOUCHED — it builds `WrittenDoc`s from the entries it
  staged + the ts `commitWrite` returns; the decorator only needs to return the right ts and land the
  same documents. `createEmbeddedRuntime({ store })` takes an arbitrary `DocStore`, so it plugs in with
  no engine change.

## Global constraints (in addition to the whole-arc plan's)
- New `ee/` package `@stackbase/objectstore-substrate` (commercial license; `license: "SEE LICENSE IN
  ../../LICENSE"`, scaffold like `ee/packages/fleet`). Depends on `@stackbase/objectstore`,
  `@stackbase/docstore`, `@stackbase/docstore-sqlite`.
- Reuse `DocStore.write(..., "Overwrite")` for BOTH bootstrap and post-CAS apply — do NOT invent a
  second explicit-ts path.
- The manifest MUST carry a MONOTONE field (`tsCounter`/`epoch`) so its content never repeats (the
  Slice-1 seam-doc note: content-hash etags → ABA; a repeating manifest would let a stale `ifMatch`
  match). `tsCounter` (= the frontier) satisfies this — it strictly increases each commit.
- Group commit is deferred to a later slice; Slice 2 does one segment PUT + one manifest CAS PER
  `commitWriteBatch` call (which is already a batch of units — fine).
- Guard atomicity (`addCommitGuard` runs in the store txn) and effectively-once are DEFERRED — Slice 2
  delegates `addCommitGuard` to the local store and documents that manifest-atomic guards are a later
  slice (the effectively-once → manifest-idempotency-window mapping). Single-shard, no fleet forwarding.

## Interfaces (produced)
```ts
// segment codec
interface SegmentPayload { documents: DocumentLogEntry[]; indexUpdates: IndexWrite[]; }
function encodeSegment(p: SegmentPayload): Uint8Array;   // JSON (bigint→string, index key→base64)
function decodeSegment(bytes: Uint8Array): SegmentPayload;
// manifest
interface Manifest { epoch: number; frontierTs: string /*bigint*/; tsCounter: string; segments: number[]; }
async function readManifest(os, shard): Promise<{ manifest: Manifest; etag: string } | null>;
async function createManifest(os, shard): Promise<{ manifest; etag }>;       // casPut(null) — create-only
async function casManifest(os, shard, next: Manifest, ifMatch: string): Promise<{ etag }>; // throws CasConflict → FencedError
// the store
class ObjectStoreDocStore implements DocStore {
  static async open(opts: { objectStore: ObjectStore; shard: string; local: SqliteDocStore }): Promise<ObjectStoreDocStore>; // creates-or-reads manifest + bootstraps local from segments
  // ...DocStore surface (reads forwarded to local; commitWrite/Batch intercepted)
}
```
Key layout: `s{shard}/manifest`, `s{shard}/seg/{seqno}` (dense seqnos = the prev_ts density role).

---

## Task 2.1 — Segment codec + manifest helpers (+ `ee/` package scaffold)

**Files:** `ee/packages/objectstore-substrate/{package.json,tsup.config.ts,tsconfig.json}`;
`src/{segment.ts,manifest.ts,index.ts}`; `test/{segment.test.ts,manifest.test.ts}`.

**Interfaces:** `encodeSegment`/`decodeSegment` (SegmentPayload ↔ bytes — JSON with `bigint`→decimal
string, `Uint8Array` index keys → base64); the `Manifest` type + `readManifest`/`createManifest`/
`casManifest` over the `ObjectStore` seam (`s{shard}/manifest` via `casPut`).

- [ ] **2.1a** Write failing `segment.test.ts`: a round-trip of a `SegmentPayload` with real
      `DocumentLogEntry[]` (bigint ts/prev_ts, a tombstone `value:null`, a `ResolvedDocument`) +
      `IndexWrite[]` (Uint8Array key, both `DatabaseIndexValue` variants) `decode(encode(p))` deep-equals `p`
      (bigints preserved, key bytes preserved). Run → fail.
- [ ] **2.1b** Implement `segment.ts` (JSON codec). Run → pass.
- [ ] **2.1c** Write failing `manifest.test.ts` (against a `MemoryObjectStore` from
      `@stackbase/objectstore/test-support`): `createManifest` writes a create-only object (a second
      `createManifest` throws `CasConflict`); `readManifest` returns it + an etag; `casManifest` with
      the right etag succeeds and returns a new etag; with a stale etag throws `CasConflict`; the
      manifest's `tsCounter` strictly increases across CASes (monotone-content invariant). Run → fail.
- [ ] **2.1d** Implement `manifest.ts` + the package scaffold (`ee/packages/fleet`-style; deps
      `@stackbase/objectstore`, `@stackbase/docstore`, `@stackbase/docstore-sqlite`). `bun install`;
      build/typecheck/test green. Run → pass. Commit.

**Gate:** segment round-trips (bigint + key bytes intact); manifest create/read/CAS correct incl.
stale-etag conflict + monotone tsCounter. Against `MemoryObjectStore` (fast).

---

## Task 2.2 — `ObjectStoreDocStore`: the decorator + object-first commit

**Files:** `src/object-doc-store.ts` (+ export); `test/object-doc-store.test.ts`.

**Mechanics:**
- Constructor takes `{ objectStore, shard, local: SqliteDocStore }`. `static open(...)`: `local.setupSchema()`;
  `readManifest` (or `createManifest` if absent, seeded `{epoch:0, frontierTs:"0", tsCounter:"0",
  segments:[]}`); **bootstrap**: for each seqno in `manifest.segments` in order, `get(seg/{seqno})` →
  `decodeSegment` → `local.write(documents, indexUpdates, "Overwrite")`; cache `{manifest, etag}` +
  `nextSeqno`.
- **Reads** — forward to `local`: `get`, `scan`, `count`, `maxTimestamp`, `getGlobal`, `writeGlobal`,
  `writeGlobalIfAbsent`, `index_scan`, `load_documents`, `previous_revisions`, all six client-verdict
  methods, `write` (the explicit-ts path — used by bootstrap), `setupSchema`, `close` (+ nothing for the
  stateless object store). `addCommitGuard` → forward to `local` (Slice-2 note: manifest-atomic guards deferred).
- **`commitWriteBatch(units, shardId?)`** — under an in-process mutex (commits serialize):
  1. `base = BigInt(cachedManifest.tsCounter)`; allocate `ts_i = base + i + 1` per unit (strictly
     increasing; also `>= local.maxTimestamp()+1` as a GREATEST guard).
  2. Stamp each unit's `documents`/`indexUpdates` with its `ts_i` → a `SegmentPayload` (all units'
     rows, ordered by unit then within-unit).
  3. `seqno = nextSeqno++`; `putImmutable(s{shard}/seg/{seqno}, encodeSegment(payload))`.
  4. `next = { epoch, frontierTs: String(maxTs), tsCounter: String(maxTs), segments: [...prev, seqno] }`;
     `casManifest(os, shard, next, cachedEtag)`. On `CasConflict` → throw a `FencedError`
     (import/reuse the transactor's fenced error type; it must NOT be OCC-retried) and DO NOT apply locally.
  5. On success: update the cached `{manifest: next, etag}`; apply each unit to `local` via
     `local.write(stampedDocs, stampedIdx, "Overwrite")`.
  6. Return `[ts_0, ts_1, …]`.
- `commitWrite(documents, indexUpdates, shardId?, opts?)` = `commitWriteBatch([{documents,indexUpdates,meta:opts?.meta}])` then `out[0]`.

- [ ] **2.2a** Failing test: `open` on an empty bucket creates the manifest + an empty local store;
      `commitWrite` of a doc returns ts=1, writes `seg/0` + advances the manifest (`frontierTs`/`tsCounter`=1,
      `segments:[0]`), and a `local.get` reflects the doc.
- [ ] **2.2b** Implement `object-doc-store.ts`. Run → pass.
- [ ] **2.2c** Failing test: **fence** — two `ObjectStoreDocStore`s over the SAME bucket (fs); the second's
      first `commitWrite` (its cached etag is now stale after the first committed) throws `FencedError`
      and lands NO segment/local write. (Single-writer-via-CAS.) Implement/verify. Commit.

**Gate:** object-first commit lands segment+manifest+local atomically-in-effect; a stale-etag committer
is fenced with no partial write. Against `objectstore-fs`.

---

## Task 2.3 — Bootstrap / faithful-materialization E2E (fs + real MinIO)

**Files:** `test/bootstrap.e2e.test.ts`.

- Commit a SERIES of mutations through `ObjectStoreDocStore` #1 (insert, update→new prev_ts, delete→tombstone,
  a few index writes) over `objectstore-fs`. Then `ObjectStoreDocStore.open` #2 over the SAME bucket →
  bootstrap → assert #2's `get`/`scan` return the IDENTICAL current state (including the tombstoned doc
  gone from scan), and #2's `maxTimestamp()` == the frontier. Assert the segment seqno chain is dense
  (`segments` = `[0..n]`) and per-doc `prev_ts` chains are intact (density check).
- [ ] **2.3a** Write the E2E over `objectstore-fs` (always-on). Run → pass.
- [ ] **2.3b** Add a gated variant over real MinIO (`STACKBASE_OBJECTSTORE_S3=1` + docker, mirror the
      Slice-1 s3 conformance gate). Run it if docker is available; default skips. Commit.

**Gate:** a second process materializes the identical state from object storage alone, on fs AND real MinIO.

---

## Task 2.4 — Wire through `createEmbeddedRuntime` (the substrate runs the engine)

**Files:** `test/runtime.e2e.test.ts` (in the substrate package or `packages/cli/test` — wherever the
runtime+schema harness is cleanest; model on `packages/cli/test/action-e2e.test.ts`'s `loadProject` +
`createEmbeddedRuntime` harness).

- `createEmbeddedRuntime({ store: await ObjectStoreDocStore.open({objectStore: fs, shard:"0", local: new
  SqliteDocStore(...)}), catalog, modules })` with a `notes` schema + `add`/`list`. Run `add` mutation →
  a `list` query reflects it (the transactor + query engine + reactive read-set all work over the
  object-storage substrate). Then a FRESH runtime over a NEW `ObjectStoreDocStore.open` on the SAME
  bucket → `list` returns the persisted rows (bootstrap-through-the-runtime).
- [ ] **2.4a** Write the runtime E2E over `objectstore-fs`. Run → pass. Commit.

**Gate:** the full engine (mutations, queries, reactive read-set) runs over `ObjectStoreDocStore`; a
fresh runtime bootstraps and serves the persisted state. **This is the slice's headline deliverable:
a mutation committed durably to a bucket, read back through the query engine, and re-materialized by a
second process — no Postgres.**

## Self-review
- Design covers §4 (commit path)/§5 (layout)/§6a (local materialization)/§7 (bootstrap) of the design
  record; snapshots (§6b), GC (§6c), fence/failover (§ multi-shard), replicas (§8 cross-node) are the
  NEXT slices, correctly deferred.
- Reuse map honored: `SqliteDocStore` (local + `write("Overwrite")`), the transactor/fan-out (untouched),
  `createEmbeddedRuntime` (arbitrary store). New: segment codec, manifest helpers, the decorator + commit
  coordination — exactly the whole-arc plan's "new" surface for this slice.
- The Slice-1 carried notes are honored: monotone `tsCounter` (ABA-safe manifest); run CAS/commit tests
  against fs/MinIO not just memory (2.2/2.3 use fs + MinIO); the fs single-process caveat is fine (Slice 2
  is single-writer).
- Type consistency: `DocumentLogEntry`/`IndexWrite` (docstore types) flow through the codec unchanged;
  the manifest `tsCounter`/`frontierTs` are decimal strings (bigint on the wire); `write("Overwrite")` is
  the one explicit-ts primitive used by both bootstrap and post-CAS apply.
