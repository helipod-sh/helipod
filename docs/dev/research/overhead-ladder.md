# Overhead Ladder — what Stackbase's transaction layer costs over raw Postgres

**Status:** RECORDED (2025-10-16). An apples-to-apples decomposition: same container, same `pg`
driver, same single-client measurement loop, three rungs of increasing work — one document write
each. Answers "is our overhead where it should be, or is there a hidden inefficiency?".

**Harness:** `ee/packages/fleet/test/bench-overhead-pg.test.ts` (embedded-postgres — no Docker needed,
opt-in `STACKBASE_BENCH_OVERHEAD=1`). Single client, sequential — isolates PER-OP overhead, not concurrency.

## The three rungs

1. **raw INSERT** — `client.query("INSERT INTO bench_raw …")`: one SQL statement, autocommit. The bare
   single-row ceiling **through our own driver + loop** (deliberately not `pgbench`'s C harness — we
   hold the driver and loop constant so only the *work* differs between rungs).
2. **store.commitWrite** — the real MVCC-log commit path (allocate `ts` via `nextval` → INSERT the
   document revision → commit guard → COMMIT), with **no executor, no OCC, no index, no reactivity**.
3. **runtime.run (full)** — the whole stack: the executor runs the JS handler, builds the read/write
   set, the transactor's OCC path commits the document **and** its `by_creation` index.

## Result (real Postgres, single client — 2025-10-16)

| rung                  | ops/s | p50 ms | p99 ms | ELU   |
|-----------------------|------:|-------:|-------:|------:|
| 1. raw INSERT         |  1980 |  0.377 |  1.886 | 0.123 |
| 2. store.commitWrite  |   561 |  1.637 |  3.422 | 0.150 |
| 3. runtime.run (full) |   464 |  2.028 |  4.058 | 0.149 |

```
raw → store = 3.53× slower   store → full = 1.21× slower   raw → full = 4.27× slower
```

## What it says — and why it means we're doing it right

- **raw → store = 3.53× (the MVCC commit envelope).** A store commit costs ~3.5× a bare insert. This
  matches the structural prediction almost exactly: a Stackbase commit is `nextval` → INSERT the
  document revision (with `prev_ts`) → commit guard → COMMIT, i.e. ~3–4 statements/round-trips versus
  one. **This is inherent to the append-only MVCC-log design, not an inefficiency** — it's the price of
  time-travel-able revisions + a race-free store-allocated commit timestamp, and it lands right where
  the design predicts. Nothing to fix here without abandoning MVCC (which you don't want).
- **store → full = 1.21× (the entire engine layer).** This is the headline. The **whole** executor —
  running the user's JS handler, building the read/write set for reactivity, the OCC/transactor path,
  and maintaining the `by_creation` index — adds only **21%** on top of the raw store commit. The
  transactional + reactive machinery is a **thin, efficient layer**, not a source of bloat. If the
  engine were doing something wasteful (redundant reads, heavy per-op allocation, an O(n) scan), this
  gap would be large. It isn't.
- **raw → full = 4.27× total.** Stackbase performs a fully transactional, reactive, index-maintaining
  mutation for ~4.3× the cost of a bare `INSERT`. For MVCC + OCC + deterministic-replay + reactivity +
  index maintenance, that is a genuinely good ratio — and it is dominated by the structural MVCC
  envelope, not the engine.
- **ELU 0.12–0.15 on every rung** (including the full mutation) — even the full path is **I/O-bound**:
  the core spends its time waiting on Postgres, not executing engine code. This corroborates the
  reactivity fan-out finding (`reactivity/fanout-benchmark.md`) with a hard per-op number: the engine's
  added CPU is negligible; the overhead is Postgres round-trips.

**Verdict: the approach is sound.** The cost is *structural* (the MVCC log's multi-statement commit),
not *incidental* (a bloated engine). The layer we actually wrote — executor + OCC + reactivity — is
only a 21% tax over the bare store commit.

## Caveats (read before quoting absolutes)

- **Docker Desktop on macOS** (`postgres:16` in a linux/arm64 VM): fsync/commit-latency semantics
  differ from bare-metal Linux, so **absolute ops/s are not production figures — the RATIOS travel**
  (that's the whole point of a same-box ladder). Same caveat as `write-sharding/b4-benchmark.md`.
- **Single client, sequential.** This measures per-op overhead, not peak throughput under concurrency
  (that's `bench-commit`). The ladder deliberately removes concurrency so the rung-to-rung gaps are
  clean.
- **Rung 2 is document-only** (no index write); rung 3 maintains the `by_creation` index. So the
  `store → full` gap includes one extra index insert (I/O) on top of the executor + OCC (CPU). Even
  with that included, the gap is only 1.21× — the engine layer is cheap.

## Reproduce

```bash
STACKBASE_BENCH_OVERHEAD=1 bun run --filter @stackbase/fleet test -- bench-overhead-pg
```
