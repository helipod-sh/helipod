# Stackbase vs Convex Self-Hosted — Comparison Scorecard (Design)

**Status:** DESIGN (2025-10-16). Phase 0 feasibility spike ALREADY PASSED — Convex self-hosted
backend runs (`ghcr.io/get-convex/convex-backend:latest`, SQLite, Docker), `npx convex dev --once`
deploys a matched app, and a `ConvexClient.onUpdate` subscription receives a reactive push after a
mutation. This spec covers turning that proven spike into a measured, reproducible scorecard.

## Why

The internal benchmarks answered "is our overhead correct?" (overhead ladder: engine adds only 21%
over a raw store commit). This answers the complementary question: **how does Stackbase compare to
the reference architecture it clones — Convex — on the metrics that define a reactive BaaS?** Same
category, same job, so it's the truest apples-to-apples validation of the whole approach.

## The framing (load-bearing — a result must be read this way)

Convex's backend is **Rust**; Stackbase is **TypeScript**; they use different internal stores. Raw
speed is **not** the scoreboard — we expect Convex's Rust core to win on throughput. The validation
question is: **are we in the same order of magnitude on propagation latency, and does our reactivity
behave correctly against the reference?** Same-ballpark = the architecture is sound. 100× off = a
design smell to investigate. The report leads with this framing.

## Metrics (both systems, identical workload)

1. **Reactive propagation latency** — write commit → each subscriber receives the push (p50/p99).
   The signature metric. N subscribers on one channel, one writer stamping `postAt`; each subscriber
   records `receiveTime − postAt`.
2. **Write throughput** — a single client firing mutations back-to-back for a window → mutations/sec
   (plus p50/p99 write latency).
3. **Query latency** — one-shot query round-trips (subscribe-first-value / `client.query`) → p50/p99.

## Matched app (identical shape on both)

- Table `messages` = `{ channelId: string, body: string, postAt: number }`, index `by_channel`.
- Mutation `send({channelId, body, postAt})` → insert.
- Query `byChannel({channelId})` → list the channel's messages.
- **Convex:** `convex/schema.ts` + `convex/messages.ts` (Convex `mutation`/`query`), deployed to the
  self-hosted backend via `npx convex dev --once`.
- **Stackbase:** the equivalent `convex/` app served by real **`stackbase serve`** (SQLite) — product
  vs product, not the embedded shortcut.

## Harness (fair: each backend via its own native WS client, shared measurement code)

One Node driver module with a shared measurement core (warmup/measure windows, sorted p50/p99,
per-write propagation correlation via `postAt`), and two thin adapters:
- **Convex adapter:** `ConvexClient` from `convex/browser` — `onUpdate(query,args,cb)` to subscribe,
  `mutation(fn,args)` to write, `query(fn,args)` one-shot.
- **Stackbase adapter:** `StackbaseClient` + `webSocketTransport` (same as `bench-fanout-ws`) —
  `subscribe(path,args,cb)`, `mutation`/`query` over the sync connection.

Both adapters expose the same interface: `subscribe(channelId, onPush)`, `send(channelId, body, postAt)`,
`queryOnce(channelId)`. The measurement code is identical across systems.

## Fairness controls

- Same machine, same Docker host, both on their default SQLite store.
- Identical workload params (subscriber count, write count, warmup/measure windows).
- Report **ratios** (Stackbase ÷ Convex) alongside absolutes, with the Rust-vs-TS framing.
- Absolute numbers are this machine (Docker Desktop on macOS) — ratios travel, not absolutes.

## Layout (standalone research artifact — NOT part of `bun test`)

```
benchmarks/convex-comparison/
  README.md                 # how to run (stand up Convex, stackbase serve, run driver)
  convex-app/               # the Convex app (schema + messages + package.json w/ convex dep)
    convex/{schema.ts,messages.ts}
  stackbase-app/            # the matched Stackbase app (convex/ dir served by stackbase serve)
    convex/{schema.ts,messages.ts}
  driver/
    measure.mjs             # shared measurement core + the 3 metric runners
    convex-adapter.mjs      # ConvexClient adapter
    stackbase-adapter.mjs   # StackbaseClient adapter
    run.mjs                 # orchestrates: run all 3 metrics on both, print the scorecard
docs/dev/research/convex-comparison.md   # the recorded scorecard + interpretation
```

Opt-in, manual, Docker-gated. It shells out to `docker compose`/`npx convex`/`stackbase serve` — it
is a research script, never a vitest test.

## Non-goals

- Not a CI test (external Convex container + `npx convex` deploy + `convex` npm).
- Not multi-node, not a raw-speed contest, not a full TPC-style suite.
- Not automated in `bun test`; numbers are hand-transcribed into the report (same discipline as the
  other benchmarks — a routine run can't overwrite the record).

## Risks / open questions (for the plan)

- **`stackbase serve` needs a committed `convex/_generated/`** (it fails fast if missing — per
  CLAUDE.md). The plan must codegen the Stackbase app before serving.
- **Convex client in Node** needs a WebSocket global (Node 24 has it — the spike confirmed the client
  connects and receives pushes).
- **Propagation-correlation** across systems: both use a `postAt` field stamped by the writer and read
  back from the pushed doc; same-process clock, so the delta is valid on each side.
- **Convex admin key / URL** are per-deployment (spike generated one); the runner regenerates/reads it.
