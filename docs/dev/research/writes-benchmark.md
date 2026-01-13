# Write/commit throughput benchmark (`--axis writes`)

The `writes` axis measures the single-node commit path: `bun run bench:writes`
(`--store sqlite|pg|both`, `--seconds N`). N concurrent client loops fire
mutations through a real `EmbeddedRuntime` over a real DocStore; each cell reports
`opsPerSec`, `p50Ms`, `p99Ms`, and `occConflicts`. Built because the reactive
read/push path is now heavily optimized (DLR Stages 1–3), and the earlier
reactive-fanout benchmark showed the reactive path is **I/O-bound on Postgres** —
i.e. the store/commit path, not the matcher, is the ceiling for real deployments.

## Baseline (this machine, 3s/cell, single node)

| Cell | SQLite ops/s | SQLite p50 / p99 (ms) | Postgres ops/s | Postgres p50 / p99 (ms) |
|---|---|---|---|---|
| insert, 1 client | 44,516 | 0.019 / 0.042 | 4,516 | 0.211 / 0.585 |
| insert, 8 clients | 46,553 | 0.019 / 0.041 | 4,617 | 1.643 / 2.678 |
| insert, 64 clients | 46,157 | 0.019 / **1.527** | 4,472 | 14.018 / **20.209** |
| rmw80, 64 clients | 25,003 | 0.119 / 5.371 | 3,984 | 15.08 / 42.138 |
| insert, 8, group **OFF** | 43,155 | 0.020 / 0.042 | 4,571 | 1.667 / 2.432 |
| insert, 8, group **ON** | 39,736 (**−8%**) | 0.022 / 0.045 | **5,896 (+29%)** | 1.288 / 2.173 |

(SQLite = in-memory; Postgres = real embedded PostgreSQL 16 with per-commit fsync.
Absolute numbers are machine-specific — the *shape* is the signal.)

## What the data says

1. **Write throughput is single-writer-bound — flat across concurrency.** 1 → 8 →
   64 clients barely moves ops/s (SQLite ~46k, PG ~4.5k); only tail latency grows
   (PG p50 0.2 → 14 ms) as clients queue behind the one serial writer. This is the
   OCC single-writer transactor's architectural signature: concurrency adds
   latency, not throughput. To scale writes you shard (multiple writers =
   `ee/@stackbase/fleet` Tier 2, already built), not thread.

2. **Postgres is ~10× slower than SQLite and fsync-bound (~4.5k ops/s).** This is
   the I/O ceiling the reactive-fanout benchmark predicted. The commit's real cost
   on PG is the fsync, not the engine.

3. **Group commit is a Postgres win and a SQLite loss — the escape hatch is
   correctly dark-off.** Batching commits into one fsync gives **+29%** throughput
   and lower latency on PG (4,571 → 5,896 ops/s at 8 clients; the gain grows with
   concurrency), but **−8%** on CPU-bound in-memory SQLite (batching overhead with
   no fsync to amortize). This confirms Fleet B4's assessment (measured 1.63× there)
   and validates shipping `STACKBASE_GROUP_COMMIT` off by default, on only where the
   fsync dominates.

4. **OCC conflicts are a multi-writer phenomenon, not single-node.** `occConflicts`
   is 0 in every single-node cell (the single writer serializes commits, so there is
   nothing to optimistically conflict with). The `rmw80` cell's ~2× cost vs `insert`
   on SQLite is the read-collect-replace work, not conflict retries. The column
   lights up on the sharded/fleet axis, where concurrent writers race.

## The lever this surfaced → group commit now defaults ON for Postgres

The axis identified group commit as the one under-utilized single-node write win, so
we characterized it properly. Full group-commit OFF-vs-ON curve on **real
containerized `postgres:16`** (`fsync=on`, `synchronous_commit=on`, real on-disk
volume — genuine fsync per commit), 5s/cell:

| clients | OFF ops/s | ON ops/s | gain | p50 OFF→ON (ms) | p99 OFF→ON (ms) |
|---|---|---|---|---|---|
| 1 | 1,149 | 1,164 | **+1% (neutral)** | 0.84 → 0.83 | 1.24 → 1.27 |
| 8 | 1,213 | 1,686 | **+39%** | 6.55 → 4.50 | 7.89 → 9.0 |
| 64 | 1,206 | 1,907 | **+58%** | 52.95 → 33.25 | 69.75 → 46.65 |

Group commit on Postgres is a **strict Pareto improvement or neutral** across the
whole concurrency range: at 1 client it's byte-identical latency (the opportunistic
"batch of 1 when idle" design adds no wait), and at 8/64 clients it's +39%/+58%
throughput **and** ~30–37% lower p50. The gain *grows* on real disk fsync vs the
embedded-PG numbers above (more fsync cost to amortize). The only blemish is a
minor p99 bump at 8 clients (7.9 → 9.0 ms), which inverts to a large p99 win at 64.

**Decision (shipped):** the single-node group-commit default is now
**store-conditional** — ON for Postgres, OFF for SQLite — resolved in
`resolveGroupCommit` (`packages/cli/src/boot.ts`); `STACKBASE_GROUP_COMMIT` still
overrides either direction. Fleet B4 had gated auto-enable on a single *global* 2×
threshold and missed (1.63×), shipping dark-off; the per-store data shows the win is
store-dependent, so a store-conditional default is the correct refinement. No
correctness risk: the group-commit failure contract is defined (a flush error rejects
every unit's promise; units retry) and the collateral-rejection hazard was already
fixed by the outbox split-retry work. Scoped to the single-node path — the fleet path
still threads its own `STACKBASE_GROUP_COMMIT` read.

# Sharded write scale-out (`--axis sharded`)

The `writes` axis showed write throughput is single-writer-bound — flat across
concurrency. `bun run bench:sharded` answers the follow-up: does **single-node
sharding** (the core `ShardedTransactor` — one per-shard writer/connection, via
`createEmbeddedRuntime({numShards})`) break that ceiling? Postgres only (sharding
parallelizes I/O only when the store has a connection per shard; SQLite is one file).
64 client loops, insert mix, group commit OFF (to isolate the sharding variable);
each cell builds its own `NodePgClient` with `commitPool: { shards: shardIdList(N) }`.

| shards | embedded PG ops/s | scale | real-disk PG ops/s | scale | real-disk p50 (ms) |
|---|---|---|---|---|---|
| 1 | 4,443 | 1.00× | 1,181 | 1.00× | 53.8 |
| 2 | 7,486 | 1.68× | 2,230 | 1.89× | 34.1 |
| 4 | 10,428 | 2.35× | 2,900 | 2.46× | 20.8 |
| 8 | 11,494 | 2.59× | 3,371 | **2.85×** | 14.3 |

## What the data says

1. **Sharding breaks the single-writer ceiling.** Write throughput scales ~2.6–2.85×
   at 8 shards (embedded and real-disk PG agree on the shape), and p50 latency drops
   sharply (53.8 → 14.3 ms on real disk) as load spreads across writers. The
   single-writer ~1.2–4.5k ops/s ceiling the `writes` axis found is not a wall — it's
   a per-shard number.

2. **Scaling is sub-linear with diminishing returns** (1.68/1.89× → 2.35/2.46× →
   2.59/2.85×). It is not 8× at 8 shards: Postgres still has one shared WAL and one
   fsync stream, and this machine has finite cores, so per-shard parallelism is capped
   by the shared storage substrate. The knee is ~4 shards; 4→8 adds little. (Real-disk
   PG scales *slightly better* at the top than embedded, because its single writer is
   more fsync-bound, leaving more serialization for the extra connections to absorb.)

3. **OCC conflicts are a multi-writer phenomenon — now visible.** The single-writer
   `writes` axis reported 0 OCC conflicts everywhere (one serial writer, nothing to
   conflict with). With 8 shards under the contended `rmw80` pool, `occConflicts`
   finally lights up (5 in a 3s window on embedded PG) — concurrent writers on the
   same shard racing the same doc trigger the transactor's deterministic-replay path.
   `rmw80` still scales ~2× (3,971 → 8,002 ops/s at 8 shards); the conflicts are rare
   and retried, not errors.

## Boundary

This is **single-node** sharding (multiple per-shard writers in one process). Multi-
*node* write scale-out (the fleet coordinator, per-shard failover, cross-node
forwarding) is `ee/@stackbase/fleet` Tier 2 and has its own `commit.bench.ts` /
`multinode-pg.bench.ts`. The takeaway for a single deployment: writes scale with
shards up to the shared-WAL knee (~4 shards, ~2.5×) before multi-node is needed.

# Multi-node fleet write scale-out (`ee/@stackbase/fleet`)

The next question: past the single-node shared-WAL knee, does adding *nodes* add
write capacity? `ee/packages/fleet/bench/multinode-pg.bench.ts` spawns N real
`serve --fleet` writer nodes (`STACKBASE_FLEET_MULTI_WRITER`) over a **shared**
Postgres, waits for the balancer to partition 4·N shards across them, and drives
concurrent writes **routed direct-to-owner** (HTTP `POST /api/run` to each shard's
owning node), measuring aggregate mut/s. Opt-in: `STACKBASE_BENCH_MULTINODE=1`.

| nodes | shards | agg mut/s | per-node mut/s | scale vs 1 | p50 (ms) | p99 (ms) |
|---|---|---|---|---|---|---|
| 1 | 4 | 2,725 | 2,725 | 1.00× | 2.51 | 8.88 |
| 2 | 8 | 3,518 | 1,759 | 1.29× | 3.69 | 14.56 |
| 3 | 12 | 3,857 | 1,286 | 1.42× | 5.01 | 20.61 |

## What the data says

1. **The shared Postgres is largely the ceiling.** Adding nodes gives *sub-linear,
   fast-flattening* returns (1.29× at 2 nodes, only 1.42× at 3), and per-node
   throughput drops as nodes are added (2,725 → 1,759 → 1,286). Every node commits to
   the same Postgres — one WAL, one fsync stream — so multi-node distributes the
   *engine* (execution/OCC/event-loop) across processes but not the *storage* I/O
   that the single-node axis already showed is the bottleneck. Latency also grows with
   node count (p50 2.5 → 5.0 ms, p99 8.9 → 20.6 ms) from cross-node coordination plus
   shared-PG contention. This is exactly the "either answer is honest" question the
   bench poses — and the answer here is: shared storage caps it.

2. **True linear write scale-out needs partitioned storage, not shared-PG
   multi-node.** To get past this ceiling each node needs its own storage substrate
   (a store-per-shard / distributed object-storage substrate — the deferred B5
   reshard / CAS-manifest direction), so fsync parallelizes across independent WAL
   streams. Shared-PG multi-node buys engine headroom and per-shard failover/HA, not
   raw write scale.

3. **Methodology caveats.** Writes here go over HTTP `POST /api/run` (a round trip +
   JSON per write), so absolute mut/s are lower than the in-process sharded axis above
   and the two are not comparable in absolute terms — the *scaling ratio* is the
   signal. The bench's naive driver does **no client-side retry**: under sustained
   load a small fraction of writes can be rejected during a lease renewal (one run
   showed 83 such rejections in the measurement window; another showed 0), which a
   real client (the receipted outbox / effectively-once path) retries transparently.
   The bench's strict `errors === 0` ship-gate can therefore trip intermittently on
   lease-churn — a robustness follow-up for the parked bench (tolerate a small
   transient rate, or add retry to the driver), not a data-loss bug.

## Where write performance stands (all three axes)

- **Group commit** (single-node, Postgres): +39–58% for free — shipped default-on in
  1.4.0.
- **Sharding** (single-node): ~2.6–2.85× to the ~4-shard shared-WAL knee.
- **Multi-node fleet** (shared PG): ~1.4× at 3 nodes — engine headroom + HA, but the
  shared WAL caps raw write scale; linear scale-out awaits partitioned storage.
