# Fleet Slice 2 — Log-Tailed Embedded Replicas on Sync Nodes

**Status:** approved design (brainstormed 2025-08-28)
**Research basis:** `docs/dev/architecture/tier2-topology-research.md` §3 principle 2 ("every node feeds itself an embedded replica by tailing the log")
**Builds on:** Fleet Slice 1 (`docs/superpowers/specs/2025-08-28-fleet-slice1-design.md`, shipped, main `07e10f0`)

## Goal

A sync node stops reading the shared Postgres primary for query/subscription work. Instead it
serves ALL reads from a **local, file-backed `SqliteDocStore` replica** fed by tailing the MVCC
document log — applied **verbatim with original timestamps**. Primary load per sync node drops
to one tail cursor; read capacity scales with node count. The physical proof: **pause Postgres
and a sync node keeps answering queries and serving subscriptions** (writes fail visibly until
it returns).

Key enabling facts (verified): `DocStore.write(documents: DocumentLogEntry[], indexUpdates:
IndexWrite[], strategy)` accepts exactly what `load_documents()` yields — apply is verbatim,
no transformation. Replica timestamps are byte-identical to the primary's, so MVCC reads,
version brackets, and range invalidation behave identically on either store.

## Non-goals

Writer-side replicas (the writer keeps slice-1 behavior: reads its own authoritative Postgres
store) · replica compaction/GC (the log is append-only today) · snapshot-copy bootstrap
(naive batched replay is v1; optimize later) · multi-writer sharding · cross-node query
routing · changing the client SDK (RYOW is server-side).

## Architecture

### 1. `SwitchableDocStore` (ee) — the store is the seam

A fleet-owned `DocStore` implementation that delegates every method to an inner store and can
`swapTo(other)` atomically. The runtime already takes its store by injection, so **no new core
seam is needed**; the whole sync-node runtime (transactor read context, QueryRuntime, executor)
runs on the switchable store without knowing it.

- **Sync boot:** delegate = `new SqliteDocStore(new NodeSqliteAdapter({ path: <data-dir>/fleet-replica.db }))`
  (file-backed — a restarted node resumes from local `maxTimestamp()` instead of replaying
  history). The replica store's `write()` is invoked ONLY by the tailer; guest writes never
  reach it (mutations forward per slice 1) — rejected approaches: a two-store runtime
  (query `db.get` reads through the transaction context, kernel.ts:150 — bifurcating the core
  read path) and reboot-on-promotion (drops the promoted node's own WS sessions).
- **Promotion:** slice-1 order gains one step —
  `observeTimestamp` → `pgStore.setWritable()` → **`switchable.swapTo(pgStore)`** →
  `forwarder.promote()` → `tailer.stop()` → `startDrivers()`. Because ts are globally
  identical across stores, in-flight subscriptions' version brackets stay coherent across the
  swap; sessions survive. The replica file remains on disk for a future rejoin as sync.

### 2. `ReplicaTailer` (ee) — one loop replaces slice 1's CommitTailer derivation

Wake on `LISTEN stackbase_commits` or the 1s poll fallback (unchanged advisory-bus posture),
then per tick:

1. **Pull** `(watermark, newMax]` from the primary: document log entries (the
   `load_documents(range)` shape — `{ts, id, value, prev_ts}`) plus full `indexes` rows
   (`index_id, key, ts, table_id, internal_id, deleted`) reconstructed as
   `IndexWrite[] = {ts, update: DatabaseIndexUpdate}` (Deleted vs NonClustered per the
   `deleted` flag — mirror the shapes the writer persists, using the store's own
   types/helpers; the slice-1 keyspace lesson applies: derive from the producer's
   representations, assert tests against the producer's helpers).
2. **Apply verbatim** to the replica: `replica.write(docs, indexWrites, <idempotent strategy>)`.
   Redelivery is at-least-once (watermark advances only after a fully successful tick), so
   re-applying an already-applied `(ts, id)` row must succeed silently — use/verify the
   `ConflictStrategy` variant that overwrites/ignores duplicates (plan-time verification
   against `packages/docstore/src/types.ts`; the Postgres store's own `ON CONFLICT` behavior
   is the reference).
3. **Derive invalidation from the same batch** (slice 1's separate derivation queries are
   deleted): index-keyspace point ranges via `decodeStorageIndexId → indexKeyspaceId`, and
   document-keyspace point ranges via `tableKeyspaceId + [internalId, successor)` — identical
   helpers and semantics to slice 1's fixed bridge, now sourced from the in-memory batch.
4. `notifyWrites(inv)` → `runtime.observeTimestamp(newMax)` → advance watermark.

**Bootstrap is the same loop**: from `replica.maxTimestamp()` (0n on a fresh file), pulled in
bounded batches (default 1000 log entries per query, looping until caught up). The node
reports its machine-readable **ready line only after initial catch-up**, so "ready" means
"serving current data". A corrupted/unopenable replica file → delete and re-bootstrap
(log a warning); apply failure → tick aborts, watermark unadvanced, next tick retries.

### 3. Read-your-own-writes across forwarding (the Turso trick)

Slice 2 introduces replica lag (~ms via NOTIFY, ≤1s via poll). Without compensation, a client
that mutates via node B then immediately queries B could read stale data. Fix, entirely
server-side:

- `/_fleet/run`'s 200 response gains `commitTs` (stringified bigint from the writer's commit
  result — already available where the response is built).
- `WriteForwarder.forward()` — before resolving — waits until the local replica watermark
  ≥ that `commitTs` (event/promise on the tailer, not polling), bounded by a **5s timeout**:
  on timeout it resolves anyway and logs a warning (availability over strict RYOW when the
  tail is wedged; the value is still returned, only read-back freshness degrades).
- No `WriteRouter` interface change — the wait lives inside the forwarder. The writer path
  (`isLocalWriter() === true`) is untouched (no lag exists there).

### 4. What promotion/failover looks like now

Identical to slice 1 from the outside (E2E re-proves it), with the swap step added. A
promoted node's replica file simply stops advancing (tailer stopped); if the process later
restarts into sync role, the tailer resumes from the file's `maxTimestamp()`. In-flight
RYOW waits on a node that gets promoted mid-wait resolve naturally (watermark check also
passes when the switchable store IS the primary — the wait predicate consults the store's
`maxTimestamp()` after promotion, or is simply released on promote).

### 5. Boundaries — what changes where

- **`ee/packages/fleet`** (all substantive work): `SwitchableDocStore`, `ReplicaTailer`
  (replaces CommitTailer's derivation-query internals; keep the public wiring shape),
  forwarder RYOW wait, node lifecycle updates (replica construction, bootstrap gate,
  promotion swap step).
- **FSL core (trivial touches only):** `/_fleet/run` response adds `commitTs` (cli
  http-handler); the fleet boot branch constructs the switchable store for the sync role
  (cli boot.ts — already fleet-conditional code). `docstore-sqlite` and `runtime-embedded`
  need **zero changes** (file-backed path and store injection already exist).
- **Without `--fleet`: byte-for-byte unchanged**, as always.

### 6. Error handling summary

| Failure | Behavior |
|---|---|
| Postgres unreachable | **Reads keep serving from the replica** (the feature); writes/lease/tail degrade visibly; tail resumes on recovery |
| Apply error mid-batch | Tick aborts, watermark unadvanced → at-least-once redelivery next tick |
| Replica file corrupt/unopenable | Delete + re-bootstrap from ts 0 (warn) |
| RYOW wait exceeds 5s | Resolve with the value anyway + warn (availability over freshness) |
| Promotion mid-RYOW-wait | Wait released by the swap (predicate satisfied by the primary store) |
| Fresh node, big log | Ready line deferred until catch-up; bounded batches keep memory flat |

### 7. Testing

- **Unit (PGlite primary → real file/`:memory:` SQLite replica):** verbatim apply
  (docs + index rows, ts/prev_ts preserved, MVCC reads at historical ts match primary);
  idempotent re-apply of the same batch; batch-derived invalidation equals slice 1's
  query-derived output for the same writes (regression bridge); RYOW wait resolves on
  watermark advance, times out at 5s, releases on promote; SwitchableDocStore swap
  atomicity (no interleaved reads hitting two stores mid-swap).
- **E2E ship gate** (extend `ee/packages/fleet/test/fleet-e2e.test.ts`):
  1. slice-1 scenarios re-proven on the replica path (election, forward+push, failover, join);
  2. **RYOW:** mutate via B → immediately query via B → value present;
  3. **offload proof:** `docker pause` the Postgres container → queries + the live
     subscription on B still answer from the replica → mutation via B fails visibly →
     `docker unpause` → a new mutation commits and fans out (reconvergence);
  4. replica persistence: B's `fleet-replica.db` exists under its data dir; restart B →
     ready line appears without full replay (assert bootstrap resumed from watermark, e.g.
     via timing or a log line).
- Full monorepo gate green throughout; non-fleet paths untouched.

## Slice 3+ preview (not this spec)

Snapshot-copy bootstrap for huge logs · replica GC/compaction keyed off oldest live snapshot ·
per-shard write scaling on the same lease machinery · autoscale/topology config.
