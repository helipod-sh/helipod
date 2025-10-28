# Multi-Node Distributed Write Throughput

**Status:** RECORDED (2025-10-16). Does Stackbase's Tier-2 write-sharding fleet actually scale write
throughput across nodes, past the single-node single-writer ceiling? Harness:
`ee/packages/fleet/test/bench-multinode-pg.test.ts` (Docker-gated, opt-in `STACKBASE_BENCH_MULTINODE=1`).

## Setup

- **N real `serve --fleet` writer nodes** (`STACKBASE_FLEET_MULTI_WRITER=1`) against a **shared
  Postgres**, using the `messages` sharded fixture (`.shardKey("channelId")`).
- The balancer partitions the shards across the nodes; the driver waits for a converged partition,
  then routes every write **directly to the shard's owner node** (`POST /api/run messages:send`), so
  no cross-node forwarding is on the hot path.
- **Shards-per-node held constant at 4** (total shards = 4·N), so each node always drives 4 shards —
  the question is purely whether adding a NODE adds aggregate capacity.
- `WRITERS_PER_NODE = 8` concurrent HTTP writers per node; warmup 2 s, measure 5 s. **Fresh Postgres
  container per cell** (the fleet persists its shard count at first boot — immutable — and stale leases
  would block the next cell's convergence).
- Machine: Apple M5 Pro, macOS 26.3, Docker Desktop. All nodes are processes on **one host**.

## Result (shared Postgres, this machine — 2025-10-16)

| nodes | shards | agg mut/s | per-node mut/s | scale vs 1 | p50 ms | p99 ms |
|------:|-------:|----------:|---------------:|-----------:|-------:|-------:|
|     1 |      4 |       675 |            675 |      1.00× |  10.71 |  27.51 |
|     2 |      8 |       943 |            472 |      1.40× |  13.56 |  44.81 |
|     3 |     12 |     1 180 |            393 |      1.75× |  16.81 |  53.62 |

## What it says

- **Multi-node write scale-out is real.** Aggregate throughput rises 675 → 943 → 1 180 mut/s as nodes
  go 1 → 2 → 3. The sharded fleet genuinely adds write capacity per node — it breaks past a single
  node's write ceiling, which is the whole point of Tier-2.
- **But it is sublinear** (1.75× at 3 nodes, not 3×), and per-node throughput falls (675 → 472 → 393).
  The cause is the **shared single Postgres**: every node commits to the same database, so they
  contend on one store's write path. The fleet parallelizes the *engine* work (executor, OCC,
  event-loop, per-shard commit pipelines) across nodes, but the store is the diminishing-returns
  ceiling. True linear write scale-out would require sharding the STORE too (a database per shard-group)
  — out of scope here.
- **Latency grows with node count** (p50 10.7 → 16.8 ms) — more shards + more cross-node coordination
  under the balancer.

## Caveats

- **All nodes run on ONE machine** (processes sharing the same CPU cores and the same Postgres). Real
  distributed hardware — separate machines for each node — would remove the shared-CPU contention and
  likely scale the *engine* axis better; the shared-store ceiling would remain until the store is also
  sharded. So 1.75× here is arguably a floor for the engine-scaling potential, not a ceiling.
- **Shared single Postgres** is the dominant limiter — this measures "more engine nodes over one DB",
  not "more DBs". The B5 object-storage / store-sharding direction is where linear write scale-out
  would come from.
- **HTTP `/api/run` per write** (not a persistent WS) and **Docker Desktop on macOS** distort absolute
  mut/s; the value is the **scale-vs-1-node ratio** (same config, only node count varies).
- **Single-writer per shard** still holds within each node (as `bench-commit` shows); this benchmark
  adds the orthogonal axis — spreading shards across nodes.

## Reproduce

```bash
STACKBASE_BENCH_MULTINODE=1 bun run --filter @stackbase/fleet test -- bench-multinode-pg
```

Numbers hand-transcribed (same discipline as the other benchmarks). The always-off default keeps this
heavy multi-container test out of routine CI.
