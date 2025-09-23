# Shards B2a — The Multi-Shard Engine (One Process)

**Status:** approved design (brainstormed 2025-08-28)
**Protocol basis:** `docs/dev/research/write-sharding/verdict.md` §b/§d (slice B2, split: B2a = shard semantics single-node; B2b = fleet distribution — separate spec later)
**Builds on:** B1 (main `d80d1dd`): commitWrite, shard_leases (lease+fence+frontier rows), epoch-fenced commit guard, fencing-first eviction, tailer→F, density assertions, frontier seeding.

## Goal

Everything shard-**semantic**, with zero fleet-topology change: per-shard parallel OCC writers
inside one runtime, the `mutation({shardBy})` API, always-on ownership guards at every tier,
and F = min over N shard frontiers. A single fleet node holds ALL shard leases and commits
**in parallel across shards** (per-shard mutexes → concurrent Postgres transactions). Ships
real write parallelism + the complete DX surface (shard mistakes error on the laptop, day one).

## Non-goals (B2b and later)

Multi-node shard distribution (lease balancer, per-shard writer_url routing/forwarding, orphan
frontier bumping, per-shard cross-node failover, the 2-writer E2E) — **B2b**. Single-shard
fast path (B3) · group commit (B4) · resharding tool + object storage (B5) · any client
protocol change · a serializable-globals API (documented pattern only: omit `shardBy` → the
mutation runs on the default shard where global tables ARE OCC-validated).

## Locked decisions

- **NUM_SHARDS = 8 default**, set at first boot via `STACKBASE_FLEET_SHARDS` (fleet) and the
  same count as virtual shards in `stackbase dev`; persisted once via
  `writeGlobalIfAbsent("fleet:numShards", …)`; immutable afterwards (boot fails fast on a
  mismatch with an instructive message; resharding = B5's offline tool).
- **Shard ids:** `"default"` (shard 0 — unsharded tables and no-`shardBy` mutations, exactly
  today's behavior) plus `"s1".."s7"` (`"s" + slot`). Routing: slot = **jump consistent hash**
  (~30-line standard implementation, movement-minimal for future resharding) over
  `canonicalKeyBytes(value)` — the shard-key value canonicalized the way the engine already
  canonicalizes values for index keys (reuse the existing value-encoding helpers from
  `@stackbase/index-key-codec`/`values`; the slice-1 lesson: producer's own helpers, never
  hand-rolled). Slot 0 maps to `"default"`.
- **Drivers (scheduler/workflow/crons/storage-reaper) run on the DEFAULT-shard lease holder
  only** — trivially satisfied single-node; revisit in B2b. Scheduled/driver-invoked sharded
  mutations resolve their shard at the executor exactly like client calls (the driver path
  calls `executor.run` directly, which is why resolution lives in the executor, below).

## Design

### D1. `ShardedTransactor` — per-shard writer state behind the existing interface

New class in `packages/transactor` implementing the existing `Transactor` interface:
internally a `Map<ShardId, ShardState>` where `ShardState = { mutex, recentCommits ring,
oracle (MonotonicTimestampOracle), activeSnapshots }` — today's `SingleWriterTransactor`
machinery verbatim, instantiated per shard on first use. `runInTransaction(fn, { shardId })`
routes to that shard's state (the option **already exists** on
`RunInTransactionOptions`). Undeclared shardId → `"default"`. Construction takes the same
deps as today plus a lazily-seeded per-shard oracle start (each shard's oracle seeds from
`store.maxTimestamp()` at first use — safe: commitWrite's `GREATEST(nextval, MAX+1)` is the
structural guarantee; the oracle is snapshot bookkeeping only, per B1).
- **Cross-shard parallelism falls out:** different shards' mutexes are independent, so two
  mutations on different shards run `commitWrite` concurrently (two Postgres transactions in
  flight — safe: different `shard_leases` rows, per-shard guards).
- `SingleWriterTransactor` remains (Tier-0-single-shard construction can keep using it, or
  `ShardedTransactor` with one shard — plan decides which the runtime constructs; behavior
  must be byte-identical either way, proven by the existing suites).
- `observeTimestamp(ts)` on the runtime fans to all shard oracles (it is a global
  "the log reached ts" signal).

### D2. Shard resolution in the executor (works for every caller, including drivers)

- `mutation({ shardBy, args, handler })`: `shardBy: string | ((args) => Value)` — a validated
  arg name (common case) or a resolver. Stored on `RegisteredFunction` (like `args` today).
- `InlineUdfExecutor.run()` for mutations: before `runInTransaction`, resolve
  `shardId = route(shardKeyValue)` from the (validated) args; pass `{ shardId }` to the
  transactor; expose the shard on the kernel context for the guards (D3). No `shardBy` →
  `"default"`. Queries/actions: never routed (actions' inner mutations resolve individually).
- The routing function (`jumpHash` + canonical bytes + NUM_SHARDS) lives in
  `packages/id-codec` next to the existing `ShardRouter` seam (a real `JumpShardRouter`
  implementing it); NUM_SHARDS reaches the executor via the catalog/options threading (plan
  decides the exact carrier — it is boot-time config, one integer).

### D3. Always-on ownership guards (kernel — every tier, including `stackbase dev`)

Using the catalog's `.shardKey` metadata (already threaded to `TableInfo`):
- **Write guard:** at `handleDbInsert`/`handleDbReplace`/`handleDbDelete` staging — if the
  target table is sharded, resolve the document's shard-key field value → slot; it must equal
  the transaction's declared shard, else an instructive error:
  `"table 'messages' is sharded by 'channelId'; this mutation runs on shard s3 but the
  document routes to s5 — declare shardBy: 'channelId' on the mutation (or write from a
  mutation whose shardBy resolves to the same value)"`. Also: inserting into a sharded table
  from an undeclared (`"default"`) mutation errors the same way. Shard-key fields are
  **immutable after insert** (replace with a changed shard-key value errors).
- **Read guard:** reads (get/query/paginate) of a **different sharded table row/range whose
  shard ≠ the transaction's shard** are rejected with an instructive error — EXCEPT on the
  default shard (no `shardBy`), where reads of sharded tables are... also rejected in B2a
  when they would cross shards? **Decision:** in B2a, a `"default"`-shard mutation may READ
  sharded tables freely (single-node: all data is local and stable at `lastCommitted` — the
  serializable-globals escape hatch pattern depends on it), and a **sharded** mutation may
  read: its home shard (serializable) + unsharded tables (split snapshot, D4) — but NOT other
  sharded tables' foreign shards (error). Queries/subscriptions (read-only, no shard) are
  untouched — they read everything as today.
- Guards live in the kernel/executor → identical behavior at Tier-0 SQLite, `stackbase dev`
  (8 virtual shards), and fleet.

### D4. Split snapshot (B2a single-node form) + write-skew documentation

A sharded mutation's reads: home-shard tables at the shard's `lastCommitted(s)` (its oracle —
serializable, OCC-validated as today, ranges recorded per shard); **unsharded tables at a
stable snapshot NOT OCC-validated** — B2a single-node reads them at the same store with
read-set recording for invalidation precision but their ranges are **excluded from OCC
conflict checks** (the documented write-skew class; the auth example named in docs verbatim
per the verdict: a revoked permission stays effective on sharded mutations for the staleness
window). Deterministic replay stays sound: both halves are stable snapshots. The escape hatch
(full serialization incl. globals) = omit `shardBy` (default shard, today's semantics).

### D5. Fleet single-node integration (B1 machinery × N)

- `setupSchema`/fleet boot creates **all N `shard_leases` rows**; the (single) fleet node's
  acquisition loop acquires ALL of them (per-shard advisory locks keyed by slot; the B1
  fencing upsert per row). The commit guard becomes **per-shard**: the guard closure reads
  the transaction's shardId (threaded through commitWrite → guard param) and fences against
  THAT row's epoch. `LeaseMonitor` heartbeats all held leases (one batched UPDATE per beat).
- **Node-batched idle-shard frontier closing** (needed the moment N>1 — an idle shard pins
  F): one transaction per beat — `nextval` once, then
  `UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $N) WHERE (shard_id, epoch) IN
  (my held (shard,epoch) pairs) AND frontier_ts < $N` — event-driven (a commit NOTIFY above a
  held idle frontier triggers, coalesced ~10ms) plus a 100ms periodic beat. A valid frontier
  for every idle shard because any future commit takes a later `nextval`.
- **Tailer:** F = `min(frontier_ts)` over ALL shard rows (`SELECT min(frontier_ts) FROM
  shard_leases`); everything else (pull, density, RYOW waitFor) unchanged from B1.
- `/_fleet/run` response gains `shardId` (additive). Frontier-lag observability: a
  `fleet: { frontier, lagMs, pinningShard }` field on the health endpoint + a console warn
  when lag exceeds ~5s naming the pinning shard.

### D6. `stackbase dev` / Tier-0 virtual shards

Dev + single-binary + non-fleet serve run the `ShardedTransactor` with the SAME shard count
(8) — all shards local, no leases, no guards-on-commit (SQLite has no commit guard), but the
**D3 ownership guards fully live** — `shardBy` mistakes and illegal cross-shard reads error
identically on the laptop. An app with no `.shardKey`/`shardBy` anywhere behaves
byte-identically to today (everything on `"default"` — the existing suites prove it).

### D7. Codegen cross-check

Where a mutation's `shardBy` names an arg and the mutation's module statically writes a
sharded table (best-effort static association — the same depth the existing codegen
analysis reaches): validate the arg exists, is required, and its validator type matches the
`.shardKey` field's type; emit a codegen-time error naming both sides. Dynamic cases fall
through to the kernel guards (which are the always-on truth).

## Error handling summary

| Failure | Behavior |
|---|---|
| Write to sharded table, wrong/undeclared shard | Instructive kernel error (every tier) |
| Shard-key field mutated on replace | Instructive kernel error |
| Sharded mutation reads a foreign sharded shard | Instructive kernel error |
| `STACKBASE_FLEET_SHARDS` mismatch with persisted count | Boot fails fast, names both values |
| Idle shard pinning F | Closed by the batched beat (≤~100ms); health field + warn if stalled |
| One shard's commit fenced | That commit aborts (B1 semantics); other shards unaffected |

## Testing

- **Unit:** ShardedTransactor (per-shard isolation: concurrent commits on two shards
  interleave; OCC conflicts detected per shard, NOT across shards for home ranges; ring/
  snapshot per shard), jump-hash routing (stability + distribution + slot-0→default),
  executor resolution (shardBy arg/resolver/missing→default), kernel guards (all error cases
  in D3, at Tier-0 SQLite — proving every-tier), split-snapshot OCC exclusion (a global-table
  read doesn't abort on concurrent global write; home-shard read does), codegen cross-check
  (match, mismatch, dynamic-fallthrough).
- **Fleet integration (PGlite):** N lease rows; per-shard guard fences the right row;
  batched idle closing advances min-F; tailer min-F pull.
- **E2E ship gate** (extend fleet-e2e, Docker-gated, all hygiene): one fleet writer + one
  sync node, a sharded fixture app (`messages.shardKey("channelId")`, `send({shardBy:
  "channelId"})`): (1) mutations on two channels routing to DIFFERENT shards commit
  **concurrently** (assert overlap: fire both, both succeed, per-shard frontiers advance
  independently); (2) a cross-shard subscription (query over all messages) opened before the
  writes receives both consistently at F; (3) RYOW across a forwarded write on a sharded
  mutation; (4) guard errors surface through the real server (wrong-shard write via
  /api/run → instructive 4xx); (5) zero skipped ts (dense-chain SQL) with N shards; (6)
  existing scenarios UNMODIFIED.
- Full monorepo gate green throughout; an app without shard annotations = byte-identical
  (the suites are the proof).

## Docs

`docs/enduser/`: a new sharding page (the `shardKey`/`shardBy` API, the guard errors, the
write-skew note with the auth example, the escape hatch, NUM_SHARDS/first-boot semantics) +
fleet.md pointer. `write-sharding-research.md` status: B2a shipped (B2b next).
