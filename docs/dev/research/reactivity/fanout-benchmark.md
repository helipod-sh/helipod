# Reactive Fan-Out Benchmark (baseline)

**Status:** RECORDED (2025-10-16). First measurement of the reactive path — the complement to
[`../write-sharding/b4-benchmark.md`](../write-sharding/b4-benchmark.md), which measures the write
commit path only. This one measures invalidation + query re-execution fan-out.

**Harness:** `packages/test/test/bench-fanout.test.ts` — `runFanoutBench({subscriptions, shape,
queryCost, seconds})` → `{reRunsPerSec, propP50Ms, propP99Ms, eluDuringStorm, writesPerSec,
subsMatchedAvg, errors}`. N loopback subscriptions run through the REAL client → sync protocol →
`SubscriptionManager` → engine invalidation path (the mechanism in `packages/test/src/reactivity.ts`),
over an in-memory SQLite store. A single writer loop bumps per-channel counter rows; each commit
invalidates the subscriptions reading that channel. `broadcast` = all N subs on one channel (one
write wakes all N); `selective` = N channels, one sub each (one write wakes exactly one). The
WebSocket end-to-end cell is `packages/cli/test/bench-fanout-ws.test.ts`. Design:
[`../../../superpowers/specs/2025-10-16-reactive-fanout-benchmark-design.md`](../../../superpowers/specs/2025-10-16-reactive-fanout-benchmark-design.md).

## Headline: invalidation matching is O(total live subscriptions) per write

The most important thing this benchmark found is a scaling characteristic, not a throughput number.
In `selective` mode **exactly one** subscription matches each write (`subsMatchedAvg = 1.0`), yet the
per-write latency scales **linearly with the total number of live subscriptions**:

| subscriptions | selective propP50 | selective propP99 | writes/s |
|--------------:|------------------:|------------------:|---------:|
|           100 |          0.31 ms  |          0.51 ms  |    4 140 |
|         1 000 |          0.94 ms  |          1.33 ms  |    1 056 |
|        10 000 |          9.14 ms  |         12.97 ms  |      108 |

A ~30× latency increase (and ~38× throughput collapse) for 100× more subscriptions, when only **one**
of them actually needed recomputing. This is **code-verified, not inferred**: on every write the sync
handler calls `SubscriptionManager.findAffectedByRanges` (`packages/sync/src/handler.ts:249`), which
does a **linear scan of every live subscription** (`packages/sync/src/subscription-manager.ts:88` —
`for (const [key, sub] of this.byKey) { … rangesIntersect(…) }`) before deciding which to re-run. And
invalidations are serialized through `notifyTail`, so each write's O(N) scan blocks the next.

**Implication:** surgical (range-precise) invalidation correctly re-runs only the affected
subscription, but *deciding* that still costs O(N) in the number of live subscriptions on the node.
For a deployment holding tens of thousands of concurrent subscriptions, write throughput degrades
with subscription count independent of how selective the writes are. The cheap fix is a data-structure
change — index subscriptions by their read range / table so matching is O(matches), not O(total) —
which would remove this wall **without** any multi-threading. (See "On Bun Workers" below: this is a
better first lever than Workers.)

## Full matrix (in-process, in-memory SQLite — 2025-10-16)

Recorded from `STACKBASE_BENCH_FANOUT=1 bun run --filter @stackbase/test test -- bench-fanout`.
Warmup 2 s discarded, measure 5 s per cell. Zero errors, zero OCC conflicts across every cell.

| subs   | shape      | qcost | reRuns/s  | propP50 | propP99 | ELU   | writes/s | matchedAvg |
|-------:|------------|-------|----------:|--------:|--------:|------:|---------:|-----------:|
|    100 | broadcast  | point |    52 040 |  2.81   |  3.86   | 0.981 |    520   |    100.0   |
|  1 000 | broadcast  | point |   495 600 |  2.93   |  4.88   | 0.980 |    495   |   1000.4   |
| 10 000 | broadcast  | point | 3 768 000 |  3.86   |  6.99   | 0.981 |    377   |  10005.3   |
|    100 | selective  | point |     4 140 |  0.31   |  0.51   | 0.980 |   4140   |      1.0   |
|  1 000 | selective  | point |     1 056 |  0.94   |  1.33   | 0.980 |   1056   |      1.0   |
| 10 000 | selective  | point |       108 |  9.14   | 12.97   | 0.980 |    108   |      1.0   |
| 10 000 | broadcast  | scan  | 3 756 000 |  3.90   |  6.83   | 0.980 |    375   |  10005.3   |

### What the matrix shows

- **Single-core re-execution/notification ceiling ≈ 3.77 M/s.** The broadcast/10k cell fans one
  write to ~10 000 subscribers at ~377 writes/s → ~3.77 M subscription re-runs pushed per second on
  one core, at a low propP99 (7 ms). That is the number a multi-core (Workers) implementation would
  have to beat to be worth its complexity. `scan` (a wider per-subscription read) barely moves it
  (3.756 M vs 3.768 M) — per-notification cost, not per-read cost, dominates the broadcast path.
- **Broadcast stays cheap per-write; selective does not.** At 10k subscriptions, broadcast sustains
  377 writes/s while selective manages only 108 — even though broadcast does 10 000 re-runs per write
  and selective does 1. The most likely reason is identical-query dedup: in broadcast all 10 000
  subscriptions are `byChannel("c0")` — the same query + args — so the engine computes the result
  once and fans it out, whereas each selective write still pays the full O(N) match scan (above) with
  little to amortize it against. *(The dedup mechanism is a hypothesis consistent with the numbers,
  not separately code-verified here; the O(N) match cost that makes selective the slower path IS
  verified.)*
- **propagation is fast when it isn't gated by the match scan** — broadcast propP50 ~2.8–3.9 ms across
  100→10 000 subscribers (it barely grows with fan-out width), confirming the notification/push step
  itself is cheap; the cost that scales is the per-write O(N) matching, most visible in selective.

## Real Postgres (Docker-gated, N ≤ 1000 cap — 2025-10-16)

Recorded from `STACKBASE_BENCH_FANOUT_PG=1 bun run --filter @stackbase/fleet test -- bench-fanout-pg`
(a real `postgres:16` container, `NodePgClient` + per-shard commit pool, wired like a production
writer — mirrors `bench-commit`'s harness). The PG variant lives in `ee/packages/fleet` (not
`packages/test`) because it needs `@stackbase/docstore-postgres`, which depends on `@stackbase/test` —
so it would create a build cycle in `packages/test`; it imports the store-agnostic `runFanoutBench`
from `@stackbase/test` and passes a `PostgresDocStore`. Capped at N ≤ 1000: seeding 10 000 channels +
subscriptions over real PG is prohibitively slow (a documented cap, not a silent truncation).

| subs   | shape      | reRuns/s | propP50 | propP99 | **ELU** | writes/s | matchedAvg |
|-------:|------------|---------:|--------:|--------:|--------:|---------:|-----------:|
|    100 | broadcast  |   29 040 |  3.73   |  7.63   | **0.132** |    290 |    100.1   |
|  1 000 | broadcast  |  292 200 |  3.93   |  6.90   | **0.148** |    292 |   1000.7   |
|    100 | selective  |      370 |  2.76   |  5.05   | **0.172** |    370 |      1.0   |
|  1 000 | selective  |      273 |  3.74   |  6.77   | **0.366** |    273 |      1.0   |

### The Postgres run resolves the confound — and the Workers question

The single most important comparison in this document is the **ELU column, SQLite vs Postgres**, at
the same cells:

| cell            | SQLite ELU | Postgres ELU |
|-----------------|-----------:|-------------:|
| 100  broadcast  |      0.981 |    **0.132** |
| 1000 broadcast  |      0.980 |    **0.148** |
| 100  selective  |      0.980 |    **0.172** |
| 1000 selective  |      0.980 |    **0.366** |

On in-memory SQLite the event loop is pinned at ~0.98; on real Postgres it is **0.13–0.37**. SQLite's
0.98 was the confound (synchronous in-memory reads + a busy driver loop = the process is always
CPU-active). Postgres tells the truth: **the reactive re-execution path is I/O-bound — the core sits
mostly idle waiting on Postgres round-trips.** This is exactly the case where the async event loop
already overlaps the waiting, and it is the case that matters, because the deployment shape that would
ever approach a reactive fan-out wall is multi-node = Postgres, not single-node SQLite.

Two secondary observations, both consistent:
- **ELU climbs with subscription count in selective** (0.172 → 0.366 as N goes 100 → 1000). That is
  the O(N) match scan (pure CPU) taking a larger share as N grows, on top of the fixed per-write PG
  I/O. At very high N the CPU match would eventually dominate — but the *fix* for that is the indexed
  matcher (below), which removes the CPU, not more threads.
- **The O(N) match still shows on PG** (selective writes/s 370 → 273, propP50 2.76 → 3.74 ms as N
  grows) — dampened relative to SQLite only because PG's per-write I/O baseline is larger, so the O(N)
  addition is a smaller *relative* share at these N. The finding is store-independent, as predicted.

## WebSocket end-to-end (real server + real sockets — 2025-10-16)

Recorded from `STACKBASE_BENCH_FANOUT_WS=1 bun run --filter @stackbase/cli test -- bench-fanout-ws`.
A real `startDevServer` (in-memory SQLite), K = 100 real WebSocket clients subscribed to one channel,
one write:

```
received = 100/100   propP50 = 4.46 ms   propP99 = 5.63 ms
```

All 100 clients received the push; end-to-end write→client-receives is ~4.5 ms p50 including
sync-protocol serialization and the loopback socket — close to the in-process broadcast/100 propP50
(2.81 ms), i.e. the WS/serialization overhead for this fan-out is on the order of ~1.5–2 ms.

## On Bun Workers — the question this benchmark was meant to inform

The design intended `eluDuringStorm` to be the verdict: ELU → ~1.0 under a storm ⇒ the main thread is
CPU-saturated ⇒ Workers justified. On **in-memory SQLite** that metric was confounded — pinned at
~0.98 in every cell (synchronous reads + a busy back-to-back writer loop = the process is always
CPU-active, regardless of fan-out; the same shared-event-loop confound `b4-benchmark.md` documents).

The **real-Postgres run resolves it decisively.** Against a real store, ELU is **0.13–0.37**, not
0.98 (see the SQLite-vs-Postgres table above). The reactive path against the production backend is
**I/O-bound**: the core spends most of its time waiting on Postgres round-trips, not executing.

**The verdict: Bun Workers are the wrong tool for this, on the backend that matters.**

- Workers parallelize **CPU-bound** work across cores. Here, on Postgres, the single core is already
  ~65–87 % idle (ELU 0.13–0.37) — there is no saturated core to relieve. Adding worker threads would
  add more threads that mostly wait on Postgres; the async event loop already overlaps that I/O. The
  SQLite ELU=0.98 that made Workers look plausible was an artifact of a synchronous, in-memory,
  no-network store — not how Stackbase runs at the scale where fan-out matters (multi-node = Postgres).
- The concrete scaling wall this benchmark actually found is the **O(N) invalidation match** — which
  is CPU, and store-independent. Its cheapest fix is an **indexed matcher** (O(matches) instead of
  O(total live subscriptions)), which needs **no threads** and removes the selective wall directly.
  That is the real lever; Workers are not.
- Workers remain a theoretical option only in a narrow future case: a *single-node SQLite* deployment
  (the one place re-execution is synchronous CPU) holding enough live subscriptions that the O(N)
  match — after indexing — still saturates a core. That is not a near-term shape, and even then the
  indexed matcher is the first move. **This benchmark's recommendation: index the subscription matcher;
  do not pursue Bun Workers for the reactive path.**

## Machine context (caveats — read before comparing numbers)

- **Hardware:** Apple M5 Pro (15 cores), 24 GB RAM, macOS 26.3 (Darwin 25.3.0, arm64). A developer
  laptop, not a quiesced bench box — treat absolute numbers as ±10–15 %.
- **Store:** in-memory SQLite (`NodeSqliteAdapter({ path: ":memory:" })`) — chosen deliberately so
  query re-execution is synchronous main-thread CPU (a clean signal, no I/O waits). Absolute ops/s are
  therefore a best-case, no-durability, no-network figure; the **shape** (O(N) match scaling,
  broadcast/selective contrast, single-core ceiling order-of-magnitude) is what travels, not the
  absolute ops/s.
- **Load driver:** in-process — the client subscription callbacks, the `EmbeddedRuntime`, and the
  writer loop all share one Node event loop (Node v24.14.1, vitest 2.1.9). This is why `eluDuringStorm`
  is confounded (above) and why the 10k cells partly measure the driver's own ceiling.
- **Measurement:** warmup 2 s discarded; 5 s window; propagation latency = per-re-run
  `performance.now() - postAt` (postAt stamped into the counter row at write time, same process/clock);
  reRunsPerSec = re-runs in window ÷ 5; deadlines checked via inline `Date.now()` (a `setTimeout` flag
  would be starved by the tight await loop — see `b4-benchmark.md`). Numbers are hand-transcribed from
  the printed table; a routine `STACKBASE_BENCH_FANOUT`-gated run does not overwrite this record.

## Reproduce

```bash
# in-process matrix, in-memory SQLite (7 cells, ~1–2 min)
STACKBASE_BENCH_FANOUT=1 bun run --filter @stackbase/test test -- bench-fanout
# in-process matrix, real Postgres (embedded-postgres, no Docker needed; N<=1000, ~2–3 min) — lives in ee/fleet
STACKBASE_BENCH_FANOUT_PG=1 bun run --filter @stackbase/fleet test -- bench-fanout-pg
# WebSocket end-to-end cell
STACKBASE_BENCH_FANOUT_WS=1 bun run --filter @stackbase/cli test -- bench-fanout-ws
```

The ungated `bun run test` runs only the always-on CI-fast smoke (small N, ~1 s) that asserts the
harness works and broadcast/selective invalidation shapes are correct; it is not a throughput signal.
