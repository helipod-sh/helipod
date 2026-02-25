# Plan: object-storage multi-shard single-node serve

**Branch:** `os-multishard-serve` · **Date:** 2026-02-20

## Goal

`stackbase serve --object-store <url> --shards N` boots ONE node that owns ALL N
object-storage lanes (write scale-out on one node over an S3 bucket) — the Tier-3
object-storage arc's biggest remaining slice, generalizing the shipped single-shard
(`shard "0"`) writer path.

## Grounding (read, not repeated here)

- `docs/superpowers/specs/2025-12-25-tier3-object-storage-substrate-design.md` §5/§6a.
- `ee/packages/objectstore-substrate/src/object-doc-store.ts` — one lane's `DocStore`.
- `packages/id-codec/src/jump-hash.ts` — `shardIdList(N)`, `shardIdForKeyValue`.
- `packages/cli/src/boot.ts` — `buildObjectStoreWriterNode` (today: hardcoded shard `"0"`,
  `numShards: 1`).
- `packages/transactor/src/shard-writer.ts` — confirms the contract: `commitWrite`/
  `commitWriteBatch` are ALWAYS called with an explicit `shardId`; `get`/`scan`/`index_scan`/
  `previous_revisions` are NEVER called with a shard id (a query spans all shards). This is
  the load-bearing fact `ShardedObjectStoreDocStore`'s read-merge is built on.
- `SqliteDocStore.write`'s `shardId` parameter is accepted but not physically used (grep
  confirms zero references inside `sqlite-docstore.ts`) — it's purely a routing concern
  above the local store, never a local-storage partition key.

## Design

### 1. `ShardedObjectStoreDocStore` (`ee/packages/objectstore-substrate/src/sharded-object-doc-store.ts`)

`implements DocStore`. Constructed over a pre-built `Map<ShardId, ObjectStoreDocStore>` (one
lane per id in `shardIdList(N)`) plus a `defaultShard` (= `"default"`) used for
deployment-level bookkeeping. The lanes are built/opened/acquired by the BOOT layer (per the
task brief: "Acquire/heartbeat/gc are driven per-lane, see the boot") — this class is a pure
DocStore-shaped decorator over an already-live lane map; it owns no lease machinery itself.

- **Writes** (`commitWrite`/`commitWriteBatch`/`write`): `shardId` selects `lanes.get(shardId)`
  and the call forwards verbatim. Missing/unknown shardId throws (a routing bug upstream, not
  a case to paper over). `commitWrite`/`write` with no shardId route to `defaultShard`
  (mirrors `DEFAULT_SHARD`'s semantics as the un-sharded table lane).
- **`addCommitGuard`**: fans the SAME guard function out to every lane (one registration each);
  returns a combined unregister that calls every lane's unregister. A guard for the sharded
  case therefore runs once per lane per commit, not globally atomic across lanes — documented
  as a caveat, matching `ObjectStoreDocStore`'s own "later slice" note on guard atomicity.
- **`get(id, readTimestamp)`**: a doc lives in exactly one lane, but the id alone doesn't
  reveal which one (the shard key is a document FIELD the DocStore layer doesn't know) — so
  probe every lane in PARALLEL (`Promise.all`) and return the single non-null hit (or null).
  Lanes are local SQLite lookups (in-process, not network) — cheap even at moderate N.
- **`scan(tableId, readTimestamp)`**: `Promise.all` over every lane's `scan`, flatten/concat —
  a table's docs are spread across lanes (or a sharded table's docs are, un-sharded tables
  live entirely in `defaultShard` but scanning every lane is still correct, just wasted work on
  the empty lanes).
- **`count(tableId)`**: sum of every lane's `count`.
- **`maxTimestamp()`**: max of every lane's `maxTimestamp` (0n if all empty).
- **`index_scan(...)`**: the hard part — a genuine k-way merge of N sorted async generators
  (each lane's own `index_scan`, called with the SAME `interval`/`order`/`limit`). A shared
  `mergeSortedAsyncGenerators` helper (byte-lexicographic key comparator, matching SQLite's own
  BLOB ordering that `SqliteDocStore.index_scan` already relies on) merges them by `order`
  (asc = ascending key, desc = descending), stopping at the global `limit`. Passing the full
  `limit` down to EACH lane (rather than dividing it) is a safe, simple over-fetch: the merged
  output takes at most `limit` total, so no lane is ever asked to supply more than the whole
  output could need. Unfinished generators are `.return()`'d on early exit (limit reached)
  to release resources.
- **`load_documents(range, order, limit)`**: same k-way merge, ordered by `ts` instead of an
  index key (a plain bigint comparator). Needed for the log-tail/change-feed contract, mirrored
  for completeness even though the writer path itself doesn't tail-read across lanes today.
- **`previous_revisions(queries)`**: `Promise.all` over every lane's `previous_revisions` with
  the FULL query array, then merge the returned maps (a given id-key resolves in at most one
  lane, so a plain merge — last-lane-wins, never actually contended — is correct).
- **`setupSchema`/`close`**: fan out to every lane.
- **`getGlobal`/`writeGlobal`/`writeGlobalIfAbsent`/client-verdict methods
  (`getClientVerdict`/`getClientFloor`/`recordClientVerdict`/`updateClientVerdictValue`/
  `pruneClientMutations`/`sweepExpiredClientMutations`)**: DEPLOYMENT-level, not per-shard —
  route to `defaultShard` consistently (single source of truth), documented explicitly (matches
  the task brief's suggested resolution).

**Correctness caveat to flag for the reviewer:** `get`/`scan`/`previous_revisions` probing
every lane is O(N) local SQLite calls per read — correct and fine for local materialization
(§6a: reads never leave the node), but a future optimization could route `get`/`previous_revisions`
by id when the caller happens to know the shard (out of scope here; DocStore's `get` signature
has no shard hint).

### 2. Boot wiring (`packages/cli/src/boot.ts`, `packages/cli/src/serve.ts`)

- New `--shards N` flag (+ `STACKBASE_FLEET_SHARDS` env, reusing `parseNumShards`), read ONLY
  on the `--object-store` writer path (ignored/absent otherwise — the existing `--fleet`
  Postgres path and non-object-store SQLite path already have their own shard resolution).
- The count is persisted via the EXISTING `ensureGlobals(objectStore, {deploymentId, numShards})`
  call (adopt-once-CAS semantics already built for this) — no new persistence machinery needed.
  An explicit `--shards`/env value that disagrees with what's already persisted in the bucket
  fails fast via the existing `numShardsMismatchError` helper.
- `buildObjectStoreWriterNode` generalizes: `numShards <= 1` keeps the EXACT existing code path
  (single `ObjectStoreDocStore.open({shard: "0", ...})`, byte-identical to today — verified by
  the existing single-shard tests staying green unchanged). `numShards > 1` builds N lanes —
  `shardIdList(numShards)` gives the engine-side ids (`"default", "s1", …`); each lane's
  object-storage `shard` key is the lane's SLOT NUMBER as a string (`"0"`, `"1"`, …), matching
  today's single-lane convention (`shard: "0"` for slot 0 = `"default"`) so N=1 is the same
  bucket layout as before. Each lane gets its own local SQLite file
  (`<dataDir>/shard-<slot>/db.sqlite`), its own `acquire()`, and its own heartbeat + gc driver
  (so a fence on one lane doesn't have to wait on another's cadence). The N lanes compose into
  one `ShardedObjectStoreDocStore`, which becomes the `store` passed to `createEmbeddedRuntime`
  along with `numShards: N`.
- Shutdown (`release`): fan `relinquish()` out to every lane, `Promise.all`.
- `ObjectStoreSubstrateModule`'s structural mirror (boot.ts keeps zero static dep on the `ee`
  package) gets a `ShardedObjectStoreDocStore` constructor entry.

## Tests

- `ee/packages/objectstore-substrate/test/sharded-object-doc-store.test.ts` — unit tests over
  `FsObjectStore` (always-on): commits routed to different lanes via `shardIdForKeyValue`,
  `scan`/`count`/`maxTimestamp`/`get` merge correctly, `index_scan` k-way-merge proven with an
  explicit interleave (asc AND desc, with a `limit` cutting mid-stream across lanes).
- `packages/cli/test/objectstore-multishard-boot.test.ts` (or extend an existing objectstore
  boot test file) — boot a node with `--shards 3` (or the `bootProject` opts directly), commit
  keys that route to different lanes via the real engine, prove a cross-shard query returns
  them all in order. A MinIO-gated arm mirrors the existing `dockerAvailable() &&
  STACKBASE_OBJECTSTORE_S3 === "1"` pattern where a serve E2E already exists.
- Existing single-shard tests (`object-doc-store.test.ts`, `objectstore-boot.test.ts`, etc.)
  must stay green UNCHANGED — the N=1 byte-identical guarantee.

## Definition of done

- `bun run build` + `bun run typecheck` green.
- `bun run --filter @stackbase/objectstore-substrate test` + `bun run --filter @stackbase/cli
  test` green.
- Everything committed to `os-multishard-serve`, not merged to main.
