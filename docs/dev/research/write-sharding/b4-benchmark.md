# Fleet B4 — Commit-Throughput Benchmark (baseline, pre-batching)

**Status:** BASELINE recorded (Task 1, 2025-10-01) — measured on the SHIPPED commit path,
**before any group-commit code exists**, per the spec's benchmark-first honest-abort criterion
([`../../../superpowers/specs/2025-10-16-fleet-b4-group-commit-design.md`](../../../superpowers/specs/2025-10-16-fleet-b4-group-commit-design.md)).
T5 re-runs the same `runCommitBench` harness verbatim post-batching and appends the "after"
table here; **if the final real-PG concurrent-load win is < 2×, the slice concludes
assessed-not-worth-it** with these numbers on record.

**Harness:** `ee/packages/fleet/test/bench-commit.test.ts` — `runCommitBench({store, numShards,
clients, mix, seconds})` → `{opsPerSec, p50Ms, p99Ms, errors, occConflicts, totalOps}`.
N concurrent client loops fire mutations back-to-back through a real `EmbeddedRuntime`
(`ShardedTransactor` at numShards > 1) over a real `PostgresDocStore`; the real-PG variant is
wired exactly like `prepareFleetNode`'s writer (`NodePgClient` with a per-shard `commitPool`,
so different shards' commits are genuinely concurrent Postgres sessions). Insert mix =
unique-doc inserts on a sharded table (high-entropy `channelId` → uniform jump-hash spread);
rmw80 = 80% inserts + 20% read-modify-write over a 64-doc pool spread across shards. Warmup
2 s (discarded), measure 5 s per cell. The PGlite variant is a CI-fast 2-cell smoke of the
harness itself, **not** a throughput signal (single in-process WASM connection).

## Baseline (real Postgres, full matrix — 2025-10-01)

| shards | mix    | clients | ops/s  | p50 ms | p99 ms | occConflicts | errors |
|-------:|--------|--------:|-------:|-------:|-------:|-------------:|-------:|
|      1 | insert |       1 |  598.8 |   1.45 |   3.37 |            0 |      0 |
|      1 | insert |       8 |  579.4 |  13.44 |  20.67 |            0 |      0 |
|      1 | insert |      64 |  550.4 | 110.07 | 146.86 |            0 |      0 |
|      1 | rmw80  |       1 |  558.0 |   1.50 |   3.42 |            0 |      0 |
|      1 | rmw80  |       8 |  583.0 |  13.39 |  19.74 |            0 |      0 |
|      1 | rmw80  |      64 |  571.6 | 105.15 | 213.99 |            0 |      0 |
|      8 | insert |       1 |  555.0 |   1.55 |   3.67 |            0 |      0 |
|      8 | insert |       8 | 1608.4 |   4.22 |  13.13 |            0 |      0 |
|      8 | insert |      64 | 1984.0 |  29.98 |  83.11 |            0 |      0 |
|      8 | rmw80  |       1 |  540.2 |   1.55 |   3.80 |            0 |      0 |
|      8 | rmw80  |       8 | 1343.6 |   5.19 |  15.30 |            0 |      0 |
|      8 | rmw80  |      64 | 1303.8 |  30.16 | 291.10 |            0 |      0 |

### What the baseline shows (the shape B4 predicts)

- **The single-shard ceiling is flat at ~550–600 ops/s regardless of client count** (1, 8, or
  64 clients — same throughput, latency scales linearly with queue depth: p50 1.45 → 13.44 →
  110 ms). That is per-shard commit serialization: the shard mutex admits one commit
  transaction (nextval → INSERTs → guard UPDATE → COMMIT) at a time, so concurrency buys
  queueing, not throughput. This per-commit round-trip cost is exactly what group commit
  amortizes — the headline B4 targets.
- **8 shards scale to ~3.6× at 64 clients** (1984 vs 550 ops/s insert) — real cross-shard
  parallelism from the per-shard commit-connection pool, but well short of 8× because each
  shard still pays the full per-commit I/O; ~2 000 ops/s ÷ 8 shards ≈ 250 ops/s/shard under a
  contended Node event loop.
- **1-client cells are the idle-latency floor** (p50 ~1.5 ms): batch-of-1 latency that group
  commit must NOT regress (the "no timer, idle = today's latency" non-goal).
- Zero unexpected errors and zero OCC-retry-exhaustions across the whole matrix (the harness
  reports `occConflicts` — retryable `OCC_CONFLICT` aborts after the transactor's 8
  deterministic replays — as its own column since the contended rmw80/64-client cells CAN
  legitimately produce them on a slower machine; a one-off earlier run recorded exactly 1).

## Machine context (caveats — read before comparing numbers)

- **Hardware:** Apple M5 Pro (15 cores: 5P+10E-class), 24 GB RAM, macOS 26.3
  (Darwin 25.3.0, arm64). A developer laptop, not a quiesced bench box — ambient load
  (IDE, browser) was present; treat numbers as ±10–15%.
- **Postgres:** `postgres:16` official image in Docker Desktop 29.4.0 (linux/arm64 VM,
  15 CPUs / ~8 GB allotted), default configuration, data on the VM's virtualized filesystem.
  **fsync/commit-latency semantics through the Docker Desktop VM differ substantially from
  bare-metal Linux** — absolute ops/s here are NOT comparable to a production deployment;
  only the *ratios* (before/after batching, shard scaling shape, latency-vs-clients shape)
  travel.
- **Networking:** loopback (`127.0.0.1` → published container port). No real network RTT.
- **Load driver:** in-process — the client loops, the `EmbeddedRuntime`, and the `pg` driver
  all share one Node event loop (Node v24.14.1, vitest 2.1.9, `pg` 8.22.0). There is no
  HTTP/WS layer in the measurement (deliberate: this benchmarks the store/transactor commit
  path group commit touches, not the serving stack). At 64 clients the event loop itself is
  a shared resource; per-op latencies include scheduling delay.
- **Measurement:** warmup 2 s discarded; 5 s window; latency = per-op `performance.now()`
  span; ops/s = completed-in-window ÷ 5. Wall-clock deadline checks (not timer-driven flags —
  a tight microtask-only loop starves Node's timer phase; the harness documents this).

## After (T5 — group commit ON, same harness, same machine)

_To be recorded by T5. The gate: ≥ 2× on the real-PG concurrent-load cells (the 8- and
64-client rows), with the 1-client idle-latency floor not regressed._
