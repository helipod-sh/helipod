---
title: iii (iii.dev) — Function Orchestration Mesh
status: research
date: 2025-08-28
---

# iii (iii.dev, formerly Motia) — what to learn / borrow

> Studied 2025-08-28 (web only — iii.dev + github.com/iii-hq/iii). Companion to the six
> deep briefs in this folder; shorter because iii is **not a competitor** — it's a
> *function orchestration mesh*, not a reactive BaaS. No reactive queries, no transactions,
> no OCC, no read-set/write-set. The borrowable parts are complementary edges, not core.

## What it is

- **Rust engine, single binary** (`iii` CLI, Docker image), Elastic License 2.0 on the engine,
  **Apache 2.0 on SDKs/CLI/console**.
- **Inverted connection model:** workers (Node/Python/Rust/Go processes) **dial INTO the engine
  over WebSocket** and register named functions + triggers — a live catalog; anything can call
  anything cross-language immediately; no deploy step.
- **Unified trigger vocabulary:** direct call, HTTP, cron, queue subscription, **state change**,
  stream event.
- Built-in workers for durable KV state (`iii-state`, with vector indexing) and streams; native
  OpenTelemetry tracing; queues with backpressure/retries/DLQ.
- **Scaling model: single hub engine; workers scale horizontally.** No documented clustering —
  the engine is the coordinator/SPOF.

## Borrows for Stackbase (ranked)

1. **Server-side `onChange` triggers — the sleeper hit (cheap, high demand).** iii treats state
   change as a first-class trigger. Stackbase reactivity currently pushes only to *clients*;
   there is no server-side "run a function when this data changes" (Convex lacks it too, and
   users ask constantly). We can build it almost for free: a driver on the existing
   recurring-driver seam subscribes to the commit fan-out, intersects committed write ranges
   against registered `onChange(query, handler)` read ranges (the same range-precise machinery
   subscriptions use), and enqueues the handler through the scheduler's at-most-once path.
   → **Feature backlog: probably the cheapest high-demand feature identified so far.**
2. **Polyglot ACTION workers via the inverted model (later, post-scaling).** Queries/mutations
   must stay TS-in-engine (deterministic replay — locked). But **actions** are already
   non-deterministic, outside the transaction, at-most-once — and our syscall ABI is already
   fully JSON-serializable, exactly the property needed to extend it over a socket. A future
   `@stackbase/worker` protocol: an external Python/Rust/Go process connects, registers named
   actions, `ctx.runAction("py/embed", …)` just works. Multi-language ML/compute without
   touching the transactional core or the TS-end-to-end decision.
3. **License split for the client SDK.** iii keeps the engine source-available (ELv2) but SDKs
   Apache — removing license anxiety from users' app bundles. Worth adopting: keep the engine
   FSL, but put **`@stackbase/client` + React hooks under MIT/Apache** — the client is adoption
   surface, not moat. (Candidate amendment to
   [business-model-and-licensing.md](../business-model-and-licensing.md).)
4. **Native OpenTelemetry** across all operations — later polish for the logs/dashboard story.

## Explicitly NOT borrowing

- **The hub topology.** A single central engine that workers attach to is exactly the
  coordinator-service/SPOF shape the Tier 2 research rejected
  ([tier2-topology-research.md](../architecture/tier2-topology-research.md) — symmetric
  log-fed fleet, the store is its own coordinator). Their workers scale; their engine doesn't.
- **"Everything is a generic function" uniformity.** Diluting the transactional-reactive core
  into generic orchestration would surrender the guarantees that make Stackbase what it is.

## Category signal

iii, Rivet, and Lunora are all entering "unified backend primitives in one binary" — each
*without* a transactional-reactive core (iii: orchestration, no reactivity; Rivet: actors, no
queries; Lunora: reactivity, no portability). Every entrant validates the category while
leaving Stackbase's square — deterministic transactions + range-precise reactivity +
deploy-anywhere — unoccupied. Borrow at the edges (actions, triggers, SDKs); never dilute the
middle.
