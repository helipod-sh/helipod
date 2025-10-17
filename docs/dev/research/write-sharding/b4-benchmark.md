# Fleet B4 — Commit-Throughput Benchmark (baseline, pre-batching)

**Status:** GATE DECIDED (T5, 2025-10-16) — **the < 2× branch: default stays OFF** (1sh 1.63×,
8sh 1.04× on the decisive cells; see [the gate decision](#the-gate-decision-default-stays-off-assessed-not-worth-it)
below). The baseline below was measured on the SHIPPED commit path, **before any group-commit
code existed**, per the spec's benchmark-first honest-abort criterion
([`../../../superpowers/specs/2025-10-16-fleet-b4-group-commit-design.md`](../../../superpowers/specs/2025-10-16-fleet-b4-group-commit-design.md)).
T5 re-ran the same `runCommitBench` harness post-batching and appended the "after" table and
decision here.

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

## After (T5 — group commit ON, same harness, same machine — 2025-10-16)

Recorded by T5 (`ee/packages/fleet/test/bench-commit.test.ts`, the "gate run" matrix). For every
cell `runCommitBench` was invoked TWICE against the SAME `postgres:16` container in ONE session —
flag **OFF** then **ON** — so the before/after is apples-to-apples on the same machine state (rather
than trusting the prior recording across a machine reboot). The `before(OFF)` column below therefore
re-establishes the baseline same-session; it lands within the documented ±10–15% of the Task-1
recording above (e.g. 1sh/64/insert 577.0 same-session vs 550.4 recorded; 8sh/64/insert 1975.4 vs
1984.0). Warmup 2 s, measure 5 s per cell, exactly as the baseline.

| shards | mix    | clients | before OFF ops/s | after ON ops/s | speedup | after p50 ms | after p99 ms |
|-------:|--------|--------:|-----------------:|---------------:|--------:|-------------:|-------------:|
|      1 | insert |       1 |            580.0 |          570.2 |  0.98×  |         1.49 |         4.13 |
|      1 | insert |       8 |            589.6 |          840.0 |  1.42×  |         9.09 |        16.84 |
|      1 | insert |      64 |            577.0 |          896.0 |  1.55×  |        67.69 |       102.12 |
|      1 | rmw80  |       1 |            564.0 |          569.2 |  1.01×  |         1.45 |         3.37 |
|      1 | rmw80  |       8 |            587.4 |          817.0 |  1.39×  |         9.41 |        17.66 |
|      1 | rmw80  |      64 |            561.4 |          926.8 |  1.65×  |        63.46 |       127.48 |
|      8 | insert |       1 |            536.2 |          596.4 |  1.11×  |         1.45 |         3.24 |
|      8 | insert |       8 |           1598.8 |         1618.0 |  1.01×  |         4.54 |        11.30 |
|      8 | insert |      64 |           1975.4 |         2060.0 |  1.04×  |        26.68 |        91.15 |
|      8 | rmw80  |       1 |            542.2 |          534.0 |  0.98×  |         1.54 |         3.88 |
|      8 | rmw80  |       8 |           1266.0 |         1308.0 |  1.03×  |         5.41 |        15.76 |
|      8 | rmw80  |      64 |           1296.6 |         1417.0 |  1.09×  |        37.04 |       147.68 |

Zero unexpected errors and zero OCC-retry-exhaustions across every cell, both OFF and ON.

**Decisive-cell repeat (flag ON, second run — the anti-massage cross-check):**

| cell               | run 1 (ON) | run 2 (ON) | delta |
|--------------------|-----------:|-----------:|------:|
| 1 shard / 64 / insert |    896.0 |      908.8 | +1.4% |
| 8 shards / 64 / insert |  2060.0 |     2065.4 | +0.3% |

The two runs agree to within ~1.4% — the decisive numbers are stable, not a lucky sample.

## THE GATE DECISION: default stays **OFF** (assessed not worth it)

**The criterion (from the plan/brief):** the 64-client, insert-heavy, real-PG cells at **both**
1 shard **and** 8 shards must reach **≥ 2×** the baseline (1sh baseline 550.4 ops/s; 8sh baseline
1984.0) to flip the default to ON.

**The measured result:**

- **1 shard / 64 / insert:** 896.0 ops/s (repeat 908.8) vs baseline 550.4 ⇒ **1.63×** (1.55× vs the
  same-session OFF of 577.0). **Below 2×.**
- **8 shards / 64 / insert:** 2060.0 ops/s (repeat 2065.4) vs baseline 1984.0 ⇒ **1.04×** (1.04× vs
  the same-session OFF of 1975.4). **Far below 2×.**

**Neither decisive cell meets the ≥ 2× bar; the 8-shard cell — the recommended sharded production
shape — is essentially flat. The gate FAILS. The default remains OFF.**

### Why the win is real but sub-2× (the honest read)

- **Group commit helps most exactly where commits SERIALIZE.** The single-shard rows are the clean
  signal: with one committer admitting one transaction at a time, batching amortizes the per-commit
  round-trip (nextval → INSERTs → guard UPDATE → COMMIT) across every commit queued behind the
  in-flight one. That buys a genuine **1.4–1.65×** at 8–64 clients (and, importantly, **does not
  regress the 1-client idle-latency floor** — 570.2 vs 580.0 ops/s, p50 1.49 ms: the "no timer, idle
  = today's latency" non-goal holds). But it is a per-round-trip amortization, not a fsync coalesce
  (the Docker-Desktop VM's commit-latency semantics blunt the classic group-commit fsync win — see
  the machine-context caveats), so it tops out well under 2×.
- **Sharding already captured most of that win.** At 8 shards the per-shard commit-connection pool
  spreads commits across 8 concurrent Postgres sessions, so each shard's *queue depth* is ~⅛ of the
  single-shard case — there is far less to batch per shard, and the measured gain collapses to
  **1.01–1.09×**. Group commit and sharding are amortizing the *same* per-commit serialization cost;
  once sharding has paid most of it, group commit has little left to reclaim.
- **Honest caveat: the queue-depth analogy is incomplete for the 8-shard magnitude.** Queue-depth
  dilution predicts a *smaller* win at 8 shards, but 64 clients ÷ 8 shards still leaves ~8 clients
  per shard — the depth that earned ~1.4× in the 1-shard/8-client cells — so the analogy alone does
  not fully explain a collapse to ~1.01–1.09×. A second factor plausibly contributes: the harness's
  shared Node event loop (see machine context above — the client loops, the `EmbeddedRuntime`, and
  the `pg` driver all share one loop). At 8 shards × 64 clients the load driver is running near its
  own ceiling (~2 000 ops/s regardless of flag state), so part of the 8-shard flatness may be
  harness saturation rather than a pure property of the mechanism. This does not change the gate
  decision — a win invisible under a realistic in-process driver is still not a default-flip case,
  and the single-shard rows (nowhere near loop saturation) remain the clean signal we quote — but
  the 8-shard rows should not be read as proof that sharding leaves *nothing* to batch.
- **Net:** the two mechanisms overlap. For the sharded, multi-writer deployment shape B2a/B2b make
  the default, the incremental throughput from also enabling group commit is within noise — not the
  step change the ≥ 2× gate demanded.

### Disposition

- **`STACKBASE_GROUP_COMMIT` stays default OFF**; the boot flag remains a supported **ops escape
  hatch** for the deployment shape where it demonstrably helps — **single-shard / single-writer-heavy**
  workloads under real concurrency (a measured 1.5–1.65× at 64 clients), where an operator has
  decided *not* to shard. All the plumbing shipped in T1–T4 (the two-buffer committer, the
  batch-shaped commit guard, `commitWriteBatch`, the health counters, the CLI/fleet wiring) stays in
  the tree, correct and tested — it is enabled by the flag, just not on by default.
- **No default-flip commit is made** (the gate's < 2× branch). This document + the T5 report are the
  honest record; the concurrent-load E2E (`fleet-e2e.test.ts`, the 64-client storm) still proves the
  ON path is correct under load (zero errors, dense chain, batching engaged with `maxBatchSize > 1`,
  effectively-once forwarding, RYOW) — correctness of the escape hatch, independent of the default.
