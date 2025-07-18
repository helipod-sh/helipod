---
title: Lunora — Architecture Research
status: research
---

# Lunora — Architecture Research

> Research date: 2025-07-04. Reflects Lunora's public docs (lunora.sh) during its **alpha** — breaking changes are expected before v1.0.0, so re-verify specifics before borrowing an exact protocol shape. Lunora is the **closest shipped prior art to Stackbase that exists**: same category (Convex-style reactive backend), same function trichotomy, same "every query is live" promise — built on the opposite architectural bet. The authz-specific analysis (RLS model, `WhereInput` predicates, relation predicates) was done earlier and lives in [`components/authz/docs/research.md`](../../../components/authz/docs/research.md) §"Prior Art: Lunora"; this brief covers the **main architecture**.

## 1. Positioning & one-line thesis

**Thesis:** "The Convex-style real-time backend that runs on **your own Cloudflare account** — typed end to end, live by default, ~$0 at idle."

- Lunora is built *of* Cloudflare primitives: **Workers** (routing, actions), **Durable Objects** (database + realtime), **D1** (global tables), **R2** (blobs), **Queues** (async), **Vectorize** (vector search), **workerd** (dev = prod runtime).
- Target user: TypeScript developers who want Convex DX with self-custody (your CF account, open source) and scale-to-zero economics.
- Status: **alpha**; a managed "Lunora Cloud" is announced but not shipped.
- Where Stackbase asks "what is the minimal storage contract for reactive transactions?" and makes the substrate an adapter, Lunora asks "what falls out of Durable Objects?" and lets the substrate *be* the architecture. Everything below follows from that one inversion.

## 2. Core architecture: the Durable Object IS the database  ← MOST IMPORTANT

Lunora inverts the usual stack: Durable Objects are not a cache or a broker in front of a database — **"The Durable Object is the database."** Three storage tiers:

| Tier | Primitive | Holds | Consistency |
|------|-----------|-------|-------------|
| 1 — **ShardDO** | Per-DO SQLite | All app tables (default: one `__root__` DO; opt-in partitioning via `.shardBy(field)`) | Strong, serialized per DO |
| 2 — **D1** (`.global()`) | Cloudflare D1 | Cross-shard identity/billing tables | Eventually consistent regional replicas; read-your-writes via `x-d1-bookmark` session header |
| 3 — **R2 / Queues** | Object store / queue | Blobs and async work | — |

Alongside current-state SQLite, every committed write is appended to an **op-log** (`__cdc_log`), which provides (a) the authoritative commit ordering and (b) the source material for reactive deltas — no separate replication stream or CDC infrastructure.

## 3. Consistency & transactions

- **Serialized writes by physics, not protocol.** A DO is single-threaded; mutations run inside `blockConcurrencyWhile` + a storage transaction, and **the commit order is the linearization point**. There is no OCC-retry loop because *"there is no concurrent writer to race."* (Contrast Stackbase: same per-shard serializability, achieved via a single-writer transactor + 3-phase OCC + deterministic UDF replay — necessary because our executors are parallel and storage is a seam.)
- **Strong consistency within a shard only.** Cross-shard transactions are explicitly rejected: join tables either denormalize into one shard or promote to `.global()` D1 (eventually consistent).
- **No MVCC.** DO SQLite is current-state; the op-log gives ordering but not point-in-time snapshot reads. (Stackbase's append-only MVCC log — reads at any `readTimestamp` — is strictly more general here, and is what makes range-precise invalidation reasoning exact.)

## 4. Realtime: the poke protocol  ← go deep

Every query is a live subscription over a **hibernatable WebSocket**. Two server protocols coexist:

1. **Legacy `subscribe`:** re-run the query, diff results, push. (This is essentially Stackbase's current model.)
2. **Poke protocol:** on each flush the DO reads the op-log once and, per subscribed **shape** (a declarative table + predicate), computes membership with *"a single `… IN (<changedIds>) AND <where>` query"* — then broadcasts **membership diffs**, never re-running the query.

Delivery mechanics:

- **Delta routing:** a mutation calls `broadcastDelta({table, ...})`; each socket carries a `SocketAttachment` mapping `subId → SubscriptionQuery`, and only sockets whose subscription's table matches receive the delta, scoped further by index predicate.
- **Hibernation:** subscriptions are serialized onto the socket via `state.serializeAttachment(...)`; after ~10s of no traffic the DO hibernates and the WebSocket suspends **without losing the subscription registry**. Idle subscribers pay storage, not compute — this is the "~$0 at idle" mechanism.
- **Resume-by-bookmark:** on reconnect (exponential backoff + jitter) the client sends the last acknowledged delta sequence; the server replays the gap from the op-log, or forces a re-seed if the op-log window was exceeded.
- **Locality win:** the DO that wrote the rows also holds the WebSockets subscribed to them — **deltas never cross a process boundary**.

## 5. Client sync: optimistic, offline, idempotent

The end-to-end write path (their chat example):

1. **Optimistic write:** client applies the row locally, tags the mutation `clientId + clientSeq`.
2. **Route:** Worker authenticates, resolves the owning shard.
3. **Linearize:** DO runs the handler in `blockConcurrencyWhile`, checks the **per-client watermark** (replay guard), inserts the row + appends to the op-log in one transaction.
4. **Poke:** DO computes shape-membership diffs, broadcasts only to matching subscriptions.
5. **Apply:** client applies the poke atomically; **TanStack DB** re-derives the view.
6. **Reconcile:** client drops the optimistic overlay when the authoritative result with matching `lastMutationId` arrives.

**Watermarks give idempotency:** *"`seq ≤ watermark` is acked without re-running; `seq > watermark + 1` is rejected"* as out-of-order. Combined with the offline queue, this is a complete exactly-once-effect client sync story. **This whole layer is what Stackbase has honestly deferred** (optimistic updates + version-gap resync — our protocol reserves `requestId` + version brackets but nothing is built).

## 6. Execution model

The Convex trichotomy, identical to ours in contract:

| Kind | Deterministic | Runs where | Data access |
|------|---------------|-----------|-------------|
| **Query** | yes | DO (against its SQLite) | direct read |
| **Mutation** | yes | DO, serialized | direct read/write + op-log append |
| **Action** | no | **Worker** | **only via query/mutation RPC — never direct DB** |

- Isolation is free: **workerd is the runtime, dev and prod** — user code always runs in V8 isolates. (Stackbase: in-process executor today with an isolate-ready serializable syscall ABI; true sandboxing is a deferred seam.)
- Even container workloads (ffmpeg, headless Chrome) are DOs that *"reach data through RPC, not the database"* — preserving the serialized DO as the single authorization and linearization point.
- Also on the function surface: internal (server-only) functions, HTTP endpoints (direct Worker routes), middleware, scheduling.

## 7. Sharding & scale

- **Default:** one `__root__` DO holds everything — pitched as right for "~80% of an application's lifecycle."
- **Per-shard ceiling:** **10 GB SQLite** and roughly **1,000 sustained req/s** per DO. At 1 GB the runtime warns: *"Plan a `.shardBy()` migration before you hit the wall."* (Note the guardrail pattern: an **advisory at 10% of the ceiling**, not a failure at 100%.)
- **`.shardBy(field)`:** one schema edit → one DO per field value ("a chat with 5,000 active channels now spreads across 5,000 DOs, each with its own SQLite, CPU budget, and hibernation timer"). Codegen re-addresses call sites; **handler code is unchanged** — the same "scaling is config, not a rewrite" promise as our tier ladder.
- **Cross-shard reads:** un-pinned queries against a `.shardBy()` table fan out through a **Query Coordinator** Worker that dispatches to every shard and merges — explicitly documented as a cold path ("avoid this in hot paths").
- **Shard security:** cross-shard access **default-denies**; `authorizeShard(identity, shardKey)` verifies ownership, or `allowUnauthenticatedShardAccess: true` when every table enforces per-row RLS.
- **The ceiling:** a workload that *cannot* be partitioned (one global feed, one giant room) funnels into a single 10 GB single-threaded DO and hits a hard wall. This is the same single-writer-per-shard bottleneck every Convex-style system has — Lunora just outsources everything *around* it (placement, geo-distribution, connection scaling, failover) to Cloudflare's actor fleet.

## 8. Feature catalog (add-on components)

For scope-mapping against our build order — each is a separate add-on package:

| Lunora feature | Notes | Stackbase status |
|---|---|---|
| Auth | first-party | ✅ shipped (`components/auth`) |
| RLS | opt-in per procedure, `WhereInput` predicates | ✅ designed deeper (authz — see §9) |
| Data masking | field-level privacy | not planned yet — good idea to catalog |
| Scheduler | scheduled jobs | 🔨 in progress (`@stackbase/scheduler`) |
| Workflows | durable, replayable multi-step operations | deferred (slice 5 adjacent) |
| Mail | email delivery | not planned |
| Rate limiting | middleware-based | not planned yet |
| Payments | provider-agnostic | not planned |
| Feature flags | OpenFeature-based | not planned |
| FTS + vector search | Vectorize-backed | deferred (behind adapters, North Star §8) |
| File storage | R2 | deferred (slice 4, `BlobStore` adapter) |
| Studio | local admin console | ✅ dashboard shipped |
| Testing harness + MCP server | AI-agent affordance | partial (vitest); MCP server worth cataloging |
| Client adapters | React, Vue, Solid, Svelte, Astro loaders | React only |
| Offline / local-first sync | TanStack DB, optimistic, watermarks | ❌ deferred — **our biggest gap** |

## 9. Lunora vs Stackbase — the fork, in one table

| | Lunora | Stackbase |
|---|---|---|
| Architectural bet | Substrate-first (Cloudflare primitives) | Seam-first (`DatabaseAdapter`, runtime, transport adapters) |
| Storage | Per-DO SQLite + op-log; D1 global | MVCC append-only log `{ts, id, value, prev_ts}` behind the adapter |
| Serializability | Actor single-threadedness (no OCC) | Single-writer transactor + 3-phase OCC + deterministic replay |
| Snapshots | None (current-state + op-log ordering) | True MVCC point-in-time reads at any `ts` |
| Invalidation | Op-log → per-shape membership diffs (poke) | Range-precise read/write-set intersection → re-execute |
| Query expressiveness on the live path | Declarative shapes (table + predicate) for poke; re-run path for the rest | Arbitrary TypeScript query functions, uniform invalidation |
| Client sync | Optimistic + offline + watermarks + bookmark resume (shipped) | Deferred (seams reserved) |
| Isolation | workerd isolates, free, dev = prod | Isolate-ready ABI; in-process today |
| Runs on | Cloudflare only | Laptop / VPS / Docker / Bun / Node; **CF D1+DO is a planned Stackbase adapter** — their deployment story fits inside our seam; the reverse is impossible |
| Maturity | Alpha, broad feature surface | Foundation shipped (131 tests), narrow surface |

Validation note: Lunora independently converged on our function trichotomy, TypeScript-predicate authorization, and reactive-by-default posture — the strongest external evidence the category and our core decisions are right. The authz research already adopted its two best refinements (read rules as `WhereInput` merged into the query; relation predicates for one-hop sharing) and deliberately exceeded it in four places (count-through-predicate, kernel-seam join gating, engine-default-ON, full-`ctx` write rules) — see [`components/authz/docs/research.md`](../../../components/authz/docs/research.md).

## 10. The ONE transferable idea

**The client-sync playbook: per-client watermarks + resume-by-bookmark over an op-log.** Tag every mutation `clientId + clientSeq`; the server keeps a per-client watermark (`seq ≤ watermark` → ack without re-running, `seq > watermark + 1` → reject as out-of-order); on reconnect the client sends its last acknowledged sequence and the server replays the gap from the ordered log or forces a re-seed. This one mechanism yields **idempotent mutations, an offline queue, optimistic-overlay reconciliation (`lastMutationId`), and gapless reconnection** — exactly the four things Stackbase deferred from the Foundation slice — and our ordered commit log (`load_documents(tsRange)`) is already the right substrate for the replay side.

What else is **adoptable** without the Cloudflare bet:

- **Shape-membership diffs as a fast path.** For subscriptions whose predicate is expressible as data (a `WhereInput`), compute `IN (<changedIds>) AND <where>` against the commit's write set instead of re-running the query — an *optimization layer* on top of our read-set/write-set primitive, not a replacement (arbitrary-TS queries keep the re-run path). Natural successor to range-precise invalidation.
- **Advisory guardrails at 10% of a ceiling.** Warn at 1 GB for a 10 GB limit, "plan your migration before you hit the wall"; `rls_uncovered_table` for tables with data but no policy. Cheap, high-trust DX — apply to shard size, subscription counts, op-log window, uncovered tables.
- **Hibernation-shaped subscription state.** Serializing the subscription registry *onto the connection* (socket attachment) so idle costs storage-not-compute is the mechanism our future Cloudflare adapter needs; even off-CF it argues for keeping per-connection subscription state serializable rather than object-graph-entangled.
- **Shard authorization as a first-class seam** (`authorizeShard(identity, shardKey)`, default-deny) — our Tier 2 ShardRouter should own this from day one.
- **Data masking** (field-level privacy) as a natural authz-layer extension; and an **MCP server** as a dashboard-adjacent AI affordance.

## 11. Weaknesses / things to avoid

- **Total substrate lock-in.** No Cloudflare account, no Lunora — no local-first-server, laptop, VPS, or air-gapped story. This is the gap Stackbase exists to fill; do not drift toward any adapter-specific behavior leaking into the engine.
- **Hard per-shard ceiling.** 10 GB / ~1k req/s per DO; an unpartitionable workload has no escape hatch. Our Postgres tier + MVCC snapshot reads give read-heavy hot spots more headroom per shard — keep that advantage.
- **No cross-shard transactions, eventually-consistent global tier.** Honest, but a real modeling constraint they push onto app developers (denormalize or promote to D1). Our Tier 2 shards by app/namespace, which sidesteps the per-field-value modeling burden at the cost of coarser shards.
- **No MVCC / point-in-time reads.** Bookmark replay covers reconnection, but there is no consistent snapshot primitive; some of our invalidation and pagination reasoning is impossible to express in their model.
- **Poke path constrains query shape.** Membership diffs require the predicate-as-data form; the moment a query is imperative they fall back to re-run-and-diff. Don't let a delta fast path narrow our query expressiveness.
- **Alpha.** Protocol details above (poke, watermark semantics, shard limits) may change before their v1; re-verify before copying any exact wire shape.

## 12. Sources

- Overview — https://lunora.sh/docs
- Architecture — https://lunora.sh/docs/architecture
- Real-time — https://lunora.sh/docs/concepts/realtime
- Sharding — https://lunora.sh/docs/concepts/sharding
- Queries & mutations — https://lunora.sh/docs/concepts/queries-mutations
- Row-level security — https://lunora.sh/docs/concepts/rls (deep-dive in [`components/authz/docs/research.md`](../../../components/authz/docs/research.md))
- Packages — https://lunora.sh/packages
