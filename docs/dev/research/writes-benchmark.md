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

## The lever this surfaces

On the single-node axis, **group commit is the one under-utilized win**: off by
default, but a measurable +29% on Postgres (the store most production deployments
use). Worth revisiting whether it should auto-enable when the store is Postgres —
Fleet B4 gated it at 2× and it came in at 1.63×, so it shipped dark-off; this axis
confirms the ~1.3–1.6× PG win holds and is the highest-value single-node write
optimization currently gated behind a flag.
