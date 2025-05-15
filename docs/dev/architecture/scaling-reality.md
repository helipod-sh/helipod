---
title: Scaling Reality — can a JS/Bun engine handle WhatsApp-class connection counts?
status: reference
audience: engineering (internal)
---

# Scaling Reality — JS/Bun vs. "Erlang/Rust for many connections"

The recurring question: *Convex's engine is Rust; we built ours in JS/Bun. Won't it fall over
under millions of simultaneous socket connections, where Erlang/Rust shine?* Here is the honest,
numbers-grounded answer, so we don't re-litigate it from intuition.

## The conflation to avoid

"Scale" bundles **two different problems** that have different answers:

1. **Holding many (mostly-idle) socket connections.** A chat server is dominated by *idle*
   sockets. This is **I/O-bound**, and an event loop (epoll/kqueue) is *good* at it — there is no
   thread-per-connection, so "single-threaded" does not mean "few connections." A single Bun/Node
   process holds **~10⁵–10⁶ idle WebSockets**, bounded by memory (~tens of KB each), not threads.
2. **CPU work per message** — JSON parse, the reactive query recompute, fan-out. This runs on the
   **one event-loop thread per process**. This is the real JS limit, and where BEAM (Erlang/Elixir,
   multi-core preemptive scheduling, per-process GC) and Rust (no GC, all cores via Tokio) genuinely
   win.

So the worry is *half right*: for raw **CPU-per-message** and cost-per-connection density,
BEAM/Rust beat JS. For **connection-holding**, JS is fine. The "Node can't do many connections"
folklore is about (2) leaking into people's mental model of (1).

## Why this is fine for us (and the numbers)

### Connection-holding
- **Per node:** target **~50k–100k** concurrent WebSockets per process as a comfortable operating
  point (memory: 100k × ~30 KB ≈ 3 GB). Bun's `Bun.serve` WS is implemented in **Zig
  (uWebSockets-class)** and is materially denser/faster than the `ws` npm package — going
  Bun-primary was, partly by luck, the right call for connection scale. **Production uses
  `Bun.serve` native WS; `ws` was only a Node-portability fallback.**
- **WhatsApp/Discord do not put everyone on one box either.** Discord (Elixir) runs *hundreds of
  thousands per node across thousands of nodes*. The BEAM advantage is *density and cost per node*,
  not a different topology — they still shard horizontally.

### The fleet (how we reach the large end)
The [scalability spectrum](./scalability-spectrum.md) already reserves the seams; the math:

- **Connections** scale **horizontally**: clients are rendezvous-hashed across a fleet of sync
  nodes (`ShardRouter.getSyncNodeId`), each holding its slice. Total CCU = nodes × per-node CCU.
  10M connections ≈ 100–200 Bun nodes. JS needs *more* nodes than a Rust impl for the same CCU
  (higher infra cost), but it **scales linearly** — there is no wall.
- **Writes** scale by **per-conversation sharding**: a conversation is the shard key, one
  single-writer transactor per shard, and conversations are independent → write throughput grows
  linearly with shard count (10¹¹ msgs/day spread over billions of conversations = a trivial rate
  per shard). This is in the data model today (`.shardKey("conversationId")`), exercised even at
  Tier 0 (one `"default"` shard).
- **CPU-per-message** scales by **stateless executors** (read-scaling pool) + the connection-sharded
  sync fleet; no single event loop does all the recompute.

### The escape hatch (the real payoff of the seams)
The sync tier talks **only** to `SyncProtocolHandler` / `SyncWebSocket` and a **serializable wire
protocol**. So if, at extreme scale, a JS sync node becomes the cost bottleneck, you can
reimplement **just that tier** as a Rust/Zig service speaking the identical protocol — the
transactor, storage, codegen, and DX stay JS. We do **not** have to rewrite the engine in Rust to
get a Rust connection tier. (Convex uses Rust for the *transaction engine*, not connection-holding;
concave used Cloudflare Durable Objects — distributed V8 isolates — for *its* sync tier, i.e. not
Rust either.)

## Industry data points
- **Supabase Realtime → Elixir/Phoenix (BEAM).** They chose BEAM specifically for the realtime
  connection tier. Strong evidence that *for that tier*, BEAM is a top choice — and a signpost for
  where we might later put a non-JS node.
- **Discord → Elixir.** Millions of concurrent users, BEAM for the gateway/fan-out.
- **Convex → Rust** for the transaction/storage engine (the CPU-heavy OCC + log), **not** for
  holding sockets.
- **concave → Cloudflare Durable Objects** (V8 isolates at the edge) for sync — distributed JS, not
  Rust.

## Decision
- **Now (Tier 0 → a few nodes):** JS/Bun is the right call. Thousands to low-hundreds-of-thousands
  of CCU on one box; the DX + single-binary win dominates. **Do not pre-optimize.**
- **Toward WhatsApp-class:** scale horizontally (sync fleet + per-conversation write shards). Use
  **`Bun.serve` native WS**, not `ws`. If per-node cost becomes the constraint, swap the **sync tier
  only** to Rust/Zig behind the existing protocol. The seams for all of this are already in the
  Tier 0 interfaces — which was the entire point of reserving them.

**Bottom line:** JS-only does **not** corner us. It is correct for the realistic majority of apps,
and the architecture preserves a surgical path to a Rust/BEAM connection tier exactly where (and
only where) it would ever be needed.
