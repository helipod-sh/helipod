# Reactive Fan-Out Benchmark — Design

**Status:** DESIGN (2025-10-16) — awaiting user review before an implementation plan.
**Author:** benchmark worktree (`fleet-b4` base).
**Related:** `ee/packages/fleet/test/bench-commit.test.ts` +
`docs/dev/research/write-sharding/b4-benchmark.md` (the existing *write-commit* benchmark this
one complements but does not overlap).

## Why (motivation)

The project has one rigorous benchmark today — `runCommitBench` — and it measures the **write
commit path only**: N client loops fire mutations, and it reports commit throughput + p50/p99.
It has **zero** measurement of the reactive dimension: no subscriptions, no invalidation, no
push. That is a gap for two reasons:

1. **Reactivity is the product's signature.** "How fast does a subscribed client see an update
   after a write commits?" and "how many concurrent subscriptions can one node re-run before the
   invalidation fan-out saturates?" are the numbers that define *this* system versus a plain
   database. No standard benchmark (YCSB, pgbench, TSBS) measures them — they must be built here.

2. **It is the decision input for single-node multi-core scaling (Bun Workers).** Bun Workers
   help most exactly where independent, read-only query re-execution saturates one CPU core — a
   reactive invalidation storm. Whether that investment is worth it is an empirical question this
   benchmark answers directly (see *Interpretation* below). The write benchmark cannot answer it;
   it never exercises re-execution fan-out.

## Goals

- Measure **fan-out capacity**: reactive re-executions completed per second under a write load,
  as a function of subscription count and invalidation shape.
- Measure **propagation latency**: write-commit → subscription re-run fired (p50/p99).
- Measure **main-thread saturation**: event-loop utilization during the storm — the direct
  signal for whether Bun Workers would help.
- Measure **true end-to-end propagation** over a real WebSocket connection (write → client
  receives push), as a smaller secondary cell.
- Reuse the proven patterns and honesty discipline of `bench-commit` (distributions not averages,
  warmup + steady-state window, CI-fast smoke always-on + heavy run opt-in, hand-transcribed
  recorded numbers so a routine CI run cannot silently overwrite them).

## Non-goals

- Not a ship-gate. There is no feature being gated; the output is a **decision document** (does
  the reactive CPU path saturate one core → do Workers pay off).
- Not a competitive "vs Convex/Supabase" benchmark. That is a later, higher-scrutiny artifact.
- Not a multi-node fleet benchmark. Single node; the reactive engine's fan-out on one process.
- Not building Bun Workers. This measures whether they are justified; it does not implement them.

## Placement

`@stackbase/client` sits **above** `packages/sync` (client imports the sync protocol), so a
benchmark that drives real subscriptions cannot live in `packages/sync/test/` without a circular
import. It belongs in `packages/test/` (the test-harness package, which already depends on
client + runtime-embedded + sync and already hosts the `createReactivity` loopback primitive).
The WS end-to-end cell needs a real server, so it lives beside the existing `*-e2e.test.ts`
suites in `packages/cli/test/`.

```
packages/test/test/bench-fanout.test.ts          # in-process primary (loopback)
packages/cli/test/bench-fanout-ws.test.ts        # WS end-to-end secondary cell
docs/dev/research/reactivity/fanout-benchmark.md  # recorded report (mirrors b4-benchmark.md)
```

Both are open-source FSL (`packages/`), the correct side of the `ee/` boundary — reactivity is
core, unlike the commercial fleet/sharding code that hosts `bench-commit`.

## Fixture (chat-shaped, shared shape with bench-commit)

A single sharded table `bench`, sharded by `channelId` (the same shape `bench-commit` uses, which
mirrors `examples/chat`'s `messages` table). One query and one mutation:

- Query `bench:byChannel(channelId)` — a subscription reads all messages in a channel. Two cost
  variants (the `queryCost` knob): `point` (a bounded `.eq(channelId).collect()` over a small
  channel) and `scan` (a wider range collect, to show per-re-run CPU sensitivity).
- Mutation `bench:post(channelId, body)` — inserts a new message into a channel. Its write range
  is the channel's index range, so it invalidates exactly the subscriptions reading that channel.

**Broadcast vs selective falls out of the fixture**, matching `SubscriptionManager`'s real
`findAffectedByRanges` behaviour:

- `broadcast`: all N subscriptions read the **same** channel. One `post` to that channel's range
  overlaps every subscription's read range → all N re-run. The pathological storm.
- `selective`: the N subscriptions are spread across **many** channels. One `post` overlaps only
  the subscriptions on that one channel → a small `k` of N re-run. Exercises the range-precise
  surgical-invalidation path under realistic spread.

## Primary harness — `runFanoutBench`

Reuses the loopback+client reactive path (the mechanism in `packages/test/src/reactivity.ts`):
`StackbaseClient(loopbackTransport(runtime.connect()))` → real sync protocol → `SubscriptionManager`
→ engine invalidation → query re-execution. This is the full reactive path minus the TCP socket
— the same wiring `examples/chat`'s tests use — so it measures real invalidation + real
re-execution, not a synthetic stand-in.

**Store choice: in-memory SQLite (deliberate).** `docstore-sqlite` reads are *synchronous*, so
query re-execution during a storm is pure main-thread CPU. That is exactly what we want to
observe saturate — an async Postgres store would inject I/O waits that muddy the event-loop
utilization signal (the main thread would idle waiting on the socket instead of saturating on
re-execution). In-memory SQLite also keeps the primary benchmark Docker-free and CI-friendly.

```ts
interface FanoutBenchOpts {
  subscriptions: number;                 // fan-out width: 100 / 1_000 / 10_000
  shape: "broadcast" | "selective";      // all-on-one-channel vs spread
  queryCost: "point" | "scan";           // per-re-run CPU
  seconds: number;                       // measurement window (warmup 2s, measure 5s — as bench-commit)
  warmupMs?: number;                     // default 2000
}

interface FanoutBenchResult {
  reRunsPerSec: number;   // reactive re-executions completed/sec — the fan-out throughput ceiling
  propP50Ms: number;      // write-commit -> subscription onChange fired
  propP99Ms: number;
  eluDuringStorm: number; // 0..1, perf_hooks.performance.eventLoopUtilization() over the window
  writesPerSec: number;   // driving write rate (context for reRunsPerSec)
  subsMatchedAvg: number; // avg subscriptions invalidated per write (confirms broadcast vs selective)
  errors: number;         // unexpected errors during the window (sanity gate asserts 0)
}
```

**Method.** Open `subscriptions` loopback subscriptions on the fixture query. A single writer
loop commits `bench:post` mutations back-to-back. Each subscription's `onChange` callback records
`performance.now() - writeCommittedAt` as a propagation sample and increments the re-run counter.
Warmup discards its samples; only the measurement window counts. `eventLoopUtilization()` is
sampled at window start and end; `eluDuringStorm` is the delta's `utilization`. Latency reported
as sorted percentiles (same `percentile` helper shape as `bench-commit`).

**Propagation timing correlation.** Each write stamps a monotonically increasing sequence /
commit time; the subscription re-run carries enough to correlate back to the triggering write so
`propP*Ms` measures *that* write's fan-out, not wall-clock drift. (Exact correlation mechanism —
e.g. tagging the posted body with the write's `performance.now()` and reading it back in the
re-run result — is an implementation-plan detail; the requirement is: propagation latency is
per-write, not an aggregate guess.)

## Knob matrix

Full cross-product would be 3 (subs) × 2 (shape) × 2 (queryCost) = 12 cells. To keep the run lean
while still exposing query-cost sensitivity, `queryCost` is a **reduced sweep**: `point` across
the full 3×2 grid (6 cells), plus a single `scan` cell at the headline (`broadcast`, 10 000 subs)
for a total of **7 cells**.

| # | subscriptions | shape | queryCost | Purpose |
|--:|--------------:|-------|-----------|---------|
| 1 | 100 | broadcast | point | small-storm floor |
| 2 | 1 000 | broadcast | point | mid storm |
| 3 | 10 000 | broadcast | point | **headline storm** — the ELU/Workers verdict cell |
| 4 | 100 | selective | point | surgical-invalidation floor |
| 5 | 1 000 | selective | point | surgical mid |
| 6 | 10 000 | selective | point | surgical at scale (confirms range-precise pays off) |
| 7 | 10 000 | broadcast | scan | query-cost sensitivity at the headline |

## Secondary — WS end-to-end cell (`bench-fanout-ws.test.ts`)

Boots a real `serve` server (in-memory SQLite), connects K real WebSocket clients to a single
channel, subscribes each, fires one `bench:post`, and times **write → each client receives the
push** (true end-to-end p50/p99, including protocol serialization + loopback network). Small: 1–2
cells (e.g. K = 100, 500). Mirrors the existing `packages/cli/test/*-e2e.test.ts` pattern that
spins up a real server. Docker-free (SQLite), but heavier than the in-process run, so opt-in.

This is the number that answers "is our reactivity fast, end to end?" — the in-process run
answers "does the reactive CPU path saturate one core?". Different questions; both wanted.

## Interpretation (the decision output)

Recorded in `fanout-benchmark.md`, reasoning from the **headline broadcast/10k cell**:

- **If `eluDuringStorm` → ~1.0 while `reRunsPerSec` plateaus** (adding subscriptions raises
  latency, not throughput): the main thread is CPU-saturated on re-execution. **Bun Workers are
  justified** — a query-worker pool could parallelize the independent re-runs across cores.
  `reRunsPerSec` is the single-thread ceiling any Workers implementation must beat to be worth it.
- **If `eluDuringStorm` stays < ~0.7**: the path is I/O- or protocol-bound, not CPU-bound on one
  core. **Workers would not help**; the bottleneck is elsewhere (store, protocol, allocation) and
  should be profiled directly.
- The `selective` cells validate that range-precise invalidation actually pays off at scale
  (`subsMatchedAvg` should stay small and `reRunsPerSec` high relative to the broadcast cells).

## Testing / CI gating (mirrors bench-commit)

- **Always-on smoke** (CI-fast): a small cell (e.g. 100 subs, broadcast, ~1s window, short
  warmup) asserting `reRunsPerSec > 0`, `errors === 0`, and `subsMatchedAvg` consistent with the
  shape. Proves the harness works; not a throughput signal.
- **Full matrix + WS cell**: opt-in (env-gated and/or long timeout), not run in routine CI. The
  test **prints** a copy-pasteable table; numbers are **hand-transcribed** into
  `fanout-benchmark.md` so a routine local run cannot silently overwrite the recorded result —
  the exact discipline `bench-commit` uses.
- Same machine-context honesty section in the report (hardware, Node/vitest versions, store =
  in-memory SQLite, "absolute numbers are this machine; ratios and the ELU signal travel").

## Risks / open questions (for the implementation plan)

- **Propagation-timing correlation mechanism** — needs a concrete, low-overhead way to tie a
  re-run back to its triggering write without the instrumentation itself dominating the CPU it
  measures. (Design requirement stated above; mechanism chosen in the plan.)
- **Loopback protocol overhead in the timing** — the in-process path includes client-reducer +
  protocol serialization. This is arguably part of the real cost, but the report must state that
  the in-process `propP*` includes it and the WS cell is the network-inclusive number.
- **ELU sampling boundaries** — `eventLoopUtilization()` must bracket exactly the measurement
  window (post-warmup), else warmup/idle dilutes the signal.
- **10 000 loopback subscriptions memory footprint** — confirm one process holds 10k subscriptions
  without GC pressure distorting the CPU signal; if it does, cap the headline at a lower N and
  note it (no silent truncation).

## References

- `ee/packages/fleet/test/bench-commit.test.ts` — the harness patterns reused (warmup/measure
  window, `Date.now()` deadline over `setTimeout` flags, error-vs-conflict counting, print-not-write).
- `packages/test/src/reactivity.ts` — the loopback+client reactive driver reused.
- `packages/sync/src/subscription-manager.ts` — `findAffectedByRanges`, the invalidation behaviour
  broadcast/selective maps onto.
- `docs/dev/research/write-sharding/b4-benchmark.md` — the report format and honesty discipline mirrored.
