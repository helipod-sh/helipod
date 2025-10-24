# Stackbase vs Convex Self-Hosted — Comparison Scorecard

**Status:** RECORDED (2025-10-16). A same-substrate, apples-to-apples comparison of Stackbase against
the reference architecture it clones — Convex — on the metrics that define a reactive BaaS. See the
design at [`../../superpowers/specs/2025-10-16-convex-comparison-scorecard.md`](../../superpowers/specs/2025-10-16-convex-comparison-scorecard.md)
and the runnable harness under [`benchmarks/convex-comparison/`](../../../benchmarks/convex-comparison/).

## Framing (read first)

Convex's backend is **Rust**; Stackbase is **TypeScript**. This is **not** a "who's faster" contest —
it is a **validation**: does Stackbase, cloning Convex's reactive-transaction architecture, land in the
same order of magnitude on the metrics that matter? Same ballpark = the architecture is sound. The
numbers below say **yes** — and, in the same substrate, Stackbase is competitive-to-faster — but the
caveats matter and are stated honestly, not buried.

## Setup — matched app, same substrate

- **App (identical on both):** a `messages` table (`channelId`, `body`, `postAt`), index `by_channel`;
  a `send` mutation (insert) and a `byChannel` query (list).
- **Convex:** `ghcr.io/get-convex/convex-backend:latest` (SQLite), deployed via `npx convex dev --once`.
- **Stackbase:** the repo's `serve` Docker image (`stackbase:latest`, file-backed SQLite), the matched
  `convex/` app bind-mounted.
- **Both run as Docker containers** on the same Docker Desktop VM (this is the load-bearing fairness
  fix — see "Methodology honesty" below). Each is driven from the host by its **own native WebSocket
  client** (`ConvexClient` / `StackbaseClient`) through the **same measurement code**
  (`benchmarks/convex-comparison/driver/measure.mjs`).
- **Machine:** Apple M5 Pro, 24 GB, macOS 26.3, Docker Desktop 29.4.0. 50 subscribers for propagation;
  single-client sequential for throughput/query; warmup + measure windows.

## Scorecard (both in Docker — 2025-10-16)

| metric                              | Stackbase | Convex | note |
|-------------------------------------|----------:|-------:|------|
| **reactive propagation p50** (50 subs) | **8.6 ms** | 13.4 ms | write → subscriber receives push |
| reactive propagation p99            | 13.7 ms   | 27.3 ms | |
| write throughput (1 client, seq)    | 2 284 mut/s | 286 mut/s | latency-bound, not a concurrency ceiling |
| write latency p50 / p99             | 0.28 / 1.90 ms | 3.25 / 7.23 ms | |
| query latency p50 / p99             | 0.12 / 0.37 ms | 0.90 / 2.22 ms | one-shot, unique args (no client cache) |
| query throughput (1 client, seq)    | 7 444 q/s | 1 143 q/s | |

## What it says

- **Propagation — the signature reactive metric — validates the architecture.** Stackbase 8.6 ms p50
  vs Convex 13.4 ms: same order of magnitude, and competitive. This is the headline: a clean-room
  TypeScript clone of Convex's reactive-transaction design delivers reactive propagation on par with
  (slightly better than) the Rust reference. The approach is sound.
- **Throughput and query also favor Stackbase in this test** (~8× and ~6.5×). Real, but **do not read
  this as "Stackbase is 8× faster than Convex"** — see the caveats. The honest takeaway is that
  Stackbase's per-operation path is lean and adds no pathological overhead over the reference.

## Concurrency (N writers, both in Docker — 2025-10-16)

The counterweight to the single-client throughput number. N independent clients each fire mutations
back-to-back; we measure aggregate mut/s and latency.

| writers | Stackbase mut/s (p50 / p99) | Convex mut/s (p50 / p99) |
|--------:|----------------------------:|-------------------------:|
|       1 | 2 321  (0.27 / 1.87 ms)     | 353  (2.63 / 5.15 ms)    |
|      16 | 1 553  (9.24 / 25.3 ms)     | 365  (41.5 / 80.7 ms)    |
|      32 | 1 849  (16.7 / 37.8 ms)     | 279  (113 / 183 ms)      |

- **Neither backend scales throughput with concurrency — both are single-writer-serialized.** Adding
  writers does not raise mut/s; it just deepens the commit queue (latency grows). This is
  architecturally expected (a single serializable writer per node) and is the same shape Stackbase's
  own `bench-commit` shows for one shard. So "throughput" here is really the **single-writer
  commit-rate ceiling**, and Stackbase's ceiling (~2 000 mut/s) sits above Convex's (~350) *in this
  config* — the caveats below still bound that.
- **Convex hits a hard concurrency cap.** At 32 writers Convex throughput *drops* to 279 mut/s with
  p50 113 ms — it is past its `APPLICATION_MAX_CONCURRENT_MUTATIONS=16` limit (queueing/rejection).
  Stackbase has no such fixed cap here and degrades gracefully (1 849 mut/s, p50 17 ms at 32).
- This test **did not** show Convex's Rust core pulling ahead under load (the hypothesis it was run to
  check) — it confirmed the single-client result and the single-writer shape on both sides.

## Caveats (these bound every number above — do not quote absolutes without them)

- **Single-node, single-writer** on both sides: these are per-node write-ceiling numbers, not a
  distributed throughput test. Stackbase's own multi-shard/multi-node path (fleet) and Convex's are
  out of scope here.
- **Default-vs-default config, not tuned-vs-tuned.** Convex self-hosted runs `RUST_LOG=info` (per-
  request logging overhead) and may fsync per commit; Stackbase's SQLite may sync less aggressively.
  Part of Convex's higher per-op latency is plausibly durability/logging it is paying for and
  Stackbase is not — a fair default-config comparison, but not proof of an engine-speed gap.
- **Convex does more per operation** — it is a hardened, feature-complete production system; some of
  its overhead buys guarantees this benchmark doesn't exercise.
- **Docker Desktop on macOS** distorts absolute latencies (VM network + fsync); the value here is the
  **same-substrate ratio** (both containers pay the same VM tax), not the absolute ms.

## Methodology honesty — why "same substrate" was load-bearing

The first attempts were **not** apples-to-apples and are recorded here so the final numbers can be
trusted:

1. **Stackbase in-process** (client + server in one process): throughput showed p50 0.04 ms and ~21 000
   mut/s — physically impossible for a real round-trip. Rejected.
2. **Stackbase as a separate native process** (still on the host, Convex in Docker): still p50 0.04 ms.
   The gap was no longer the process boundary but the **substrate** — Convex pays Docker Desktop's VM
   network tax (~ms/round-trip on macOS) while native Stackbase does not. Reporting this would have
   been substrate-inflated benchmarketing (a spurious ~60× "win"). Rejected.
3. **Both in Docker containers** (the numbers above): Stackbase's propagation moved 2.0 → 8.6 ms and
   throughput 18 000 → 2 284 mut/s once it paid the same VM tax — confirming (1)/(2) were inflated, and
   making the comparison honest.

## Reproduce

```bash
# 1. Convex backend
cd .reference/convex-backend/self-hosted && docker compose up -d backend
docker compose exec backend ./generate_admin_key.sh      # -> CONVEX admin key

# 2. Convex app + run (from benchmarks/convex-comparison/convex-app, .env.local with URL+admin key)
npm install && npx convex dev --once
node bench-convex.mjs

# 3. Stackbase container (matched app, committed _generated)
bun packages/cli/dist/bin.js codegen --dir benchmarks/convex-comparison/stackbase-app/convex
docker build --target runner -t stackbase:latest .
docker run -d --name stackbase-bench -p 3310:3000 -e STACKBASE_ADMIN_KEY=bench-admin-key \
  -v "$PWD/benchmarks/convex-comparison/stackbase-app/convex":/app/convex:ro \
  -v stackbase-bench-data:/data stackbase:latest

# 4. Stackbase run (same measure.mjs, against the container)
STACKBASE_PORT=3310 bun benchmarks/convex-comparison/bench-stackbase.mjs
```

Numbers are hand-transcribed here (same discipline as the other benchmarks); a routine run does not
overwrite this record.
