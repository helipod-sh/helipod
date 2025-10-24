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

## On Bun Workers — the question this benchmark was meant to inform (and why it can't, cleanly)

The design intended `eluDuringStorm` (event-loop utilization) to be the verdict: ELU → ~1.0 under a
storm ⇒ the main thread is CPU-saturated ⇒ Workers justified. **That metric came back confounded and
should not be read as a Workers verdict.** ELU is pinned at ~0.98 in *every* cell — including the
selective/10k cell doing only 108 writes/s, which is nowhere near a fan-out storm. The cause is the
harness itself: the writer is a tight back-to-back `await runtime.run(...)` loop, so the event loop is
~98 % active regardless of fan-out. ELU here measures "the process is CPU-busy" (trivially true with a
busy driver and a synchronous in-memory store), not "re-execution specifically saturates a core." This
is the same shared-event-loop confound documented in `b4-benchmark.md`'s in-process driver caveat.

What ELU *does* weakly confirm: with in-memory SQLite the reactive path is CPU-bound, not I/O-bound
(no socket waits diluting it) — which is a precondition for Workers helping at all. But it does not
discriminate a storm from light load, so it cannot set a saturation threshold.

**The honest read on Workers from this data:**

- The single-core reactive ceiling (~3.77 M notifications/s broadcast) is high; most single-node
  deployments will not approach it, so parallelizing re-execution across cores is **not** an obvious
  near-term need.
- The concrete single-node scaling wall this benchmark actually found is the **O(N) invalidation
  match**, and the cheapest fix for that is an **indexed matcher** (O(matches) instead of O(total)),
  which needs no threads and removes the selective wall directly. That is a better first lever than
  Bun Workers.
- Workers remain a valid *later* option for parallelizing independent re-execution once (a) the
  matcher is indexed and (b) a corrected benchmark — one whose driver does not itself pin the event
  loop — shows re-execution CPU as the bottleneck. Getting a clean saturation signal requires
  decoupling the load driver from the measured work (e.g. a fixed-rate driver, or measuring
  `process.cpuUsage()` attributable to re-execution separately from the driver loop). That correction
  is deferred; this baseline does not make the Workers case either way.

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
# in-process matrix (7 cells, ~1–2 min)
STACKBASE_BENCH_FANOUT=1 bun run --filter @stackbase/test test -- bench-fanout
# WebSocket end-to-end cell
STACKBASE_BENCH_FANOUT_WS=1 bun run --filter @stackbase/cli test -- bench-fanout-ws
```

The ungated `bun run test` runs only the always-on CI-fast smoke (small N, ~1 s) that asserts the
harness works and broadcast/selective invalidation shapes are correct; it is not a throughput signal.
