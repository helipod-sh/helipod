# Fenced Frontier B1 — Store-Allocated Timestamps, Epoch-Fenced Commits, Wedged-Writer Failover

**Status:** approved design (brainstormed 2025-08-28)
**Protocol basis:** `docs/dev/architecture/write-sharding-research.md` + the canonical verdict
(`docs/dev/research/write-sharding/verdict.md` §b, slice B1)
**Builds on:** the shipped fleet (slices 1+2+hardening, main `874439e`+)

## Goal

The Fenced Frontier protocol at ONE shard (`"default"`): pure hardening of the shipped fleet,
behavior-identical to users, valuable even if sharding stops here. It closes two shipped
correctness/availability holes: (1) the **allocated-but-unlanded timestamp window** (today the
oracle allocates commitTs in memory before the store write — a crash between allocation and
landing can strand readers' assumptions; with parallel writers in B2 it becomes the skipped-ts
bug), and (2) **no failover for a WEDGED writer** (today liveness is only the advisory lock —
a wedged-but-alive writer holds it forever). After B1, B2 ("N shards live") is mostly
parameterization.

## Non-goals

Multiple shards / `shardBy` routing (B2) · frontier-closing beats for idle shards (B2 —
at one shard F advances exactly with commits) · single-shard fast path (B3) · group commit
(B4) · any client-protocol or wire change · any user-visible API change.

## Design

### D1. Store-allocated commitTs — one contract at every tier

`DocStore` gains ONE method (verbatim `write()` untouched — the replica apply path depends on it):

```ts
/** Commit a transaction's staged rows, allocating the commit timestamp inside the store's own
 * atomicity domain. Entries arrive with placeholder ts (0n); the store stamps every document
 * and index row with the allocated ts and returns it. Postgres: nextval inside the commit
 * transaction — the ts becomes visible atomically with its rows (no allocated-but-unlanded
 * window). SQLite: the existing counter, same semantics. */
commitWrite(
  documents: readonly DocumentLogEntry[],   // ts fields ignored/overwritten
  indexUpdates: readonly IndexWrite[],       // ts fields ignored/overwritten
  shardId?: ShardId,
): Promise<bigint>;
```

- **Transactor change** (`packages/transactor/src/single-writer-transactor.ts:192-235`):
  phase 2+3 merge — validate (unchanged, `c.ts > snapshotTs && reads.intersects`) →
  build entries with `ts: 0n` placeholders (prev_ts chaining unchanged: computed from
  `docStore.get(w.id)` BEFORE allocation, ts-independent) →
  `const commitTs = await this.docStore.commitWrite(entries, indexWrites, shardId)` →
  ring push `{ts: commitTs, writes}` → `oracle.publishCommitted(commitTs)` → OplogDelta as
  today. The oracle keeps `getLastCommittedTimestamp`/`publishCommitted`/`observeTimestamp`
  (snapshot tracking); `allocateTimestamp` is no longer called by the transactor (keep the
  interface member; document as legacy).
- **Postgres impl:** `BEGIN; SELECT nextval('stackbase_ts'); INSERT documents...; INSERT
  indexes...; <commit guard — D3>; COMMIT` — one transaction. The sequence is created in
  `setupSchema` (idempotent), seeded to `GREATEST(current maxTimestamp, 1)` on first creation
  so existing deployments continue their ts line seamlessly (`setval` guarded by the same
  IF-NOT-EXISTS-style check; document the exact idempotent recipe in the plan).
- **SQLite impl:** allocate from the store's existing counter (max(ts)+1 discipline it already
  maintains for callers), stamp, write in its existing transaction, return. Tier-0 semantics
  byte-identical.
- **Conformance:** the shared docstore conformance suite gains commitWrite cases (allocation
  monotonic, rows stamped uniformly, returned ts visible via get/index_scan/maxTimestamp,
  placeholder ts never leaks) — run against SQLite AND PGlite as always.
- `EmbeddedRuntime.create`'s oracle seeding (`startTs = maxTimestamp()`) is unchanged and stays
  correct (snapshots still derive from publishCommitted).

### D2. `shard_leases` absorbs `fleet_lease` (ee-owned DDL)

```sql
CREATE TABLE IF NOT EXISTS shard_leases (
  shard_id        TEXT PRIMARY KEY,          -- 'default' only, in B1
  epoch           BIGINT NOT NULL,           -- the fence; +1 on every acquisition AND eviction
  writer_url      TEXT,                      -- NULL = orphaned (fenced, awaiting re-lease)
  writer_app_name TEXT,                      -- the holder's pg application_name (for takeover)
  expires_at      TIMESTAMPTZ NOT NULL,      -- TTL heartbeat target
  frontier_ts     BIGINT NOT NULL DEFAULT 0, -- F: everything <= this is durably present & dense
  prev_ts         BIGINT NOT NULL DEFAULT 0  -- the previous frontier (chain step)
);
```

- `LeaseManager` rewires to this table with `shard_id='default'` (the `fleet_lease` table is
  abandoned in place — coordination state is ephemeral; fleet nodes upgrade together; note in
  docs). Acquisition = advisory lock (fast path, as shipped) THEN the fencing upsert:
  `epoch+1, writer_url, writer_app_name, expires_at = now() + TTL` (TTL default **15s**).
- **Heartbeat = the LeaseMonitor probe.** The existing `SELECT 1` probe becomes
  `UPDATE shard_leases SET expires_at = now() + TTL WHERE shard_id='default' AND epoch=$mine`
  every 5s (probe cadence unchanged) — one round-trip serves liveness-probe + TTL maintenance
  + fence verification. 0 rows updated = fenced → same exit path as today's probe-exhaustion
  (log + exit(1)). Miss/timeout semantics of the shipped LeaseMonitor stay as-is.

### D3. Epoch-fenced commits (the commit guard seam)

Core stays lease-ignorant. `PostgresDocStore` gains:

```ts
/** Runs inside every commitWrite transaction, after the row inserts, before COMMIT.
 * Throwing aborts the whole commit. Fleet installs the epoch fence here. */
setCommitGuard(guard: (q: PgQuerier, commitTs: bigint) => Promise<void>): void;
```

Fleet (writer boot + promotion) installs:
`UPDATE shard_leases SET prev_ts = frontier_ts, frontier_ts = $commitTs WHERE
shard_id='default' AND epoch = $myEpoch` — 0 rows → throw `FencedError` → transaction aborts
→ the commit fails visibly → the node self-demotes via the existing exit policy (wire
`FencedError` into the LeaseMonitor exit path: any FencedError from a commit = definitive
loss, exit immediately). Frontier publication, fencing, and lease are ONE row; the guard adds
zero extra round-trips (rides the commit transaction). SQLite/Tier-0: no guard installed;
`commitWrite` never calls one.

### D4. Fencing-first eviction + wedged-writer takeover

A sync node's acquire loop, on observing `expires_at < now()` (checked alongside the existing
advisory-lock try, every 2s):

1. **Fence:** `UPDATE shard_leases SET epoch = epoch + 1, writer_url = NULL,
   frontier_ts = GREATEST(frontier_ts, (SELECT nextval('stackbase_ts'))) WHERE
   shard_id='default' AND expires_at < now()` — Postgres row-locking serializes this against
   any in-flight commit's frontier UPDATE on the same row: **the straggler lands-and-is-counted
   (its ts ≤ the bumped frontier) or its epoch-predicated guard matches 0 rows and the whole
   commit aborts. No third outcome.** (The fencer sets `lock_timeout = 2s` + retries on the
   next loop tick, so it never blocks indefinitely behind a long commit.)
2. **Terminate:** `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE
   application_name = $old_writer_app_name` (from the row, captured before the fence) — frees
   the wedged holder's advisory lock. (Per-node `application_name` shipped in the hardening
   slice; now load-bearing.)
3. **Acquire:** the shipped advisory-lock acquisition + fencing upsert (epoch bumps again —
   monotonic, fine) → shipped 7-step promotion.
4. The old writer, on revival: first heartbeat/commit hits 0-rows → FencedError → exit(1) →
   supervisor restarts → rejoins as sync (shipped rejoin path).

Writer connections additionally set `idle_in_transaction_session_timeout` (5s) and
`statement_timeout` (10s) at session start (NodePgClient config, fleet-threaded) so wedged
sessions die in bounded time even without a fencer.

### D5. Tailer targets F, with density assertions

`ReplicaTailer`'s pull target becomes **F = the lease row's `frontier_ts`** (read via the
existing client; type-branded — see D6) instead of `primary.maxTimestamp()`. Pull `(wm, F]`,
apply, `wm := F`. At one shard F advances exactly with commits, so behavior (latency,
batching, RYOW timing) is unchanged — RYOW's `waitFor(commitTs)` is satisfied the moment the
tailer applies through the commit's own frontier bump.

**Density assertions (defense-in-depth; the construction is the guarantee):** during apply,
for every document entry whose `prev_ts != null`, assert the replica's current head revision
for that document equals `prev_ts` — a skipped commit that touched any document seen again
crashes loudly (delete replica + re-bootstrap is the operator remedy, already shipped) instead
of serving silent corruption. Plus: F monotonically non-decreasing across reads; `wm` never
exceeds F. (Known limitation, documented: a skipped commit touching only never-again-written
documents is not caught by the chain check — it is prevented by construction, D1+D3.)

### D6. `StablePrefixTs` branding + fan-out threading

- `ee/packages/fleet`: `type StablePrefixTs = bigint & { readonly __stablePrefix: unique symbol }`
  — the tailer's pull target, watermark, and RYOW wait threshold take/return this brand;
  constructing one is only possible from the lease-row frontier read or a prior watermark.
  Feeding a raw log ts (e.g. `maxTimestamp()`) where a frontier is required becomes a compile
  error inside the fleet package.
- **Additive columns:** `shard_id TEXT NOT NULL DEFAULT 'default'` on `documents` and
  `indexes` via idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `setupSchema`
  (existing deployments upgrade in place; PKs unchanged). `commitWrite` stamps it from its
  `shardId` param. The fan-out payload gains `shardId` (additive field, threaded from the
  existing OplogDelta.shardId).

## Error handling summary

| Failure | Behavior |
|---|---|
| Crash between old-style allocate and land | **Impossible by construction** (ts allocated inside the commit transaction) |
| Wedged writer (GC pause, SIGSTOP, idle-in-txn) | TTL expires (≤15s) → fenced → terminated → another node promotes; straggler commit aborts or lands-before-fence — never skipped |
| Fenced commit (0-row guard) | Whole transaction aborts; `FencedError`; writer exits(1); supervisor restarts; rejoins as sync |
| Fencer blocked behind a long commit | `lock_timeout` + retry (bounded) |
| Density violation on replica apply | Crash loudly + logged; operator remedy = delete replica file (shipped re-bootstrap) |
| Clean shutdown | Unchanged (monitor stops before store close; heartbeat UPDATE ceases; lease expires naturally) |

## Testing

- **Unit/conformance:** commitWrite conformance cases on SQLite + PGlite (monotonic allocation,
  uniform stamping, atomic visibility, placeholder-ts never leaks); transactor against the new
  contract (OCC ring uses returned ts; snapshot semantics unchanged — existing transactor suite
  green); commit-guard invocation order + FencedError abort (PGlite: guard that throws → no rows
  landed); LeaseManager on shard_leases (acquisition fencing, heartbeat-updates-expiry, fenced
  heartbeat → 0 rows); eviction fencing logic (row-level: fence UPDATE vs concurrent commit
  UPDATE — PGlite is single-connection, so the serialization itself is E2E-only; unit-test the
  SQL + state transitions); tailer F-targeting + density assertions (construct a violation
  directly → crash path); StablePrefixTs compile-level checks.
- **E2E ship gate** (extend `ee/packages/fleet/test/fleet-e2e.test.ts`, Docker-gated, all
  shipped hygiene):
  1. **Existing scenarios green UNMODIFIED** (election, forward+push, replica reads, pause-
     offload, RYOW incl. actions, pg_terminate self-exit, failover, persistence) — the
     behavior-identical proof.
  2. **NEW wedged-writer scenario:** `SIGSTOP` the writer under write traffic → TTL expires →
     a sync node fences (epoch bump observed), terminates the wedged backends, promotes, and
     commits new writes → `SIGCONT` the old writer → assert its process exits (FencedError
     path) and that every pre-stop commit is either present-below-F or absent entirely (no
     partial/skipped ts — verify via the density assertions surviving a full replica
     re-bootstrap and a direct log-density SQL check over the affected range).
- Full monorepo gate green throughout; non-fleet suites untouched.

## Docs

`docs/enduser/deploy/fleet.md`: failover section gains wedged-writer coverage (TTL-based, ~15s
bound, in addition to the instant crash-failover); upgrade note (fleet nodes upgrade together;
`fleet_lease` superseded by `shard_leases`). `docs/dev/architecture/write-sharding-research.md`
status: B1 SHIPPED (when done).

## B2 preview (not this spec)

`shardBy` routing API + codegen cross-check, per-shard leases/transactors/drivers/promotion,
node-batched frontier closing for idle shards, split snapshot (global tables at F), 8 virtual
shards in `stackbase dev`, the 2-writer cross-shard-subscription E2E.
