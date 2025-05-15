---
title: Stackbase — System Design (North Star)
status: draft
audience: engineering (internal)
---

# Stackbase — System Design (North Star)

> This is the internal architecture document for **Stackbase**: an open-source, Convex-compatible, self-hostable Backend-as-a-Service that is **lightweight by default and scalable on demand**. It synthesizes the [reference research](../research/comparison.md) into one coherent design. It is the technical "north star" — not yet an implementation plan (that comes per build-slice).

## 1. The thesis in one paragraph

Most backend latency and most backend *complexity* come from the seams between separate services — app server, database, cache, pub/sub, realtime broker — talking over the network. Stackbase removes those seams. It runs your TypeScript functions (queries, mutations, actions — authored exactly like Convex) directly against a storage engine hidden behind one narrow interface, and it makes results **reactive** using a single primitive: a query records *what it read*, a mutation records *what it wrote*, and any subscription whose reads overlap a write is recomputed and pushed. Because that primitive only needs an *ordered, point-in-time range scan*, the same engine runs on embedded SQLite (a single ~30MB binary, PocketBase-light) or on Postgres across many nodes (Convex-scalable) **with no change to your app code**. Speed comes from keeping the hot path in-process, serializing writes through one transactional path, evaluating subscriptions incrementally, and pushing compact binary deltas (the SpacetimeDB playbook). Flexibility comes from making storage, transport, and execution swappable adapters (the concave playbook).

## 2. Design goals & the tension we are resolving

| Goal | Concretely means | Source of idea |
|------|------------------|----------------|
| **Great DX** | Reactive `useQuery`, end-to-end types, `stackbase dev`, codegen, Convex-compatible authoring | Convex |
| **Lightweight** | One binary, embedded DB, zero external services, runs on a $5 VPS or a laptop | PocketBase |
| **Fastest realtime** | Sub-ms hot path, push (never poll), incremental deltas, binary protocol | SpacetimeDB |
| **Deploy anywhere, cheap** | Same artifact on Docker / Bun / Node / Cloudflare / a desktop app | concave |
| **Scalable** | Scale reads horizontally; shard writes by app; separate sync tier; multi-region | Convex + Supabase (and avoid Supabase's weight) |

These conflict. A single in-process binary (light) is the opposite of a multi-tier distributed system (scalable). **We do not pick one.** We make them the **same system at two operating points**, connected by stable internal interfaces, so moving up a tier is configuration — never a rewrite. (§6.)

## 3. The core primitive: reactive transactions over an ordered log

This is the heart of the system. Get it right and everything else follows; get it wrong and nothing else matters.

- **Every write goes through one logical writer (the *transactor*)** which assigns a monotonically increasing commit timestamp `ts` and appends the committed transaction to an **ordered log**. This gives serializability cheaply (the hard concurrency problem becomes "append in order").
- **Queries are deterministic and read-only.** As a query executes, the engine records its **read set**: the exact tables + index ranges (e.g. `messages.by_channel ∈ ["c1", "c1"]`) it touched at snapshot `ts`. Determinism is required so the read set is meaningful and the query can be safely re-run — so queries may **not** do IO, random, or clock access (those belong in actions, §4).
- **Mutations are deterministic read/write transactions.** They run via Optimistic Concurrency Control: execute against snapshot `ts`, then the transactor commits only if no conflicting write landed in between; otherwise retry. On commit, the mutation produces a **write set** (the ranges it modified).
- **Reactivity = overlap.** A subscription is a query plus its recorded read set. When a transaction commits with write set `W`, the sync tier finds every subscription whose read set **intersects** `W`, recomputes those queries at the new `ts`, and pushes the result. No polling, no manual cache invalidation, no pub/sub topics to wire up. This is the Convex/concave convergence and it is **storage-independent** — the sync tier operates on ranges and timestamps, never on the database directly.

```
        ┌─────────── ordered commit log (ts: 1,2,3,…) ───────────┐
write → │  Transactor (single logical writer; OCC; assigns ts)   │
        └───────────────────────┬───────────────────────────────┘
                                 │ emits {ts, writeSet}
                                 ▼
   read → Executor(s) ──record readSet──►  Sync Tier
   (stateless, scalable)                   (holds subscriptions = query + readSet)
                                            on write: if writeSet ∩ readSet → recompute & push delta
                                                                 │ binary delta over WS/SSE
                                                                 ▼
                                                              Clients
```

## 4. Execution model (functions)

Compatible with Convex authoring; we own the runtime.

| Kind | Deterministic | DB access | External IO | Runs where |
|------|---------------|-----------|-------------|------------|
| **Query** | yes | read | no | Executor (sandboxed V8 isolate) |
| **Mutation** | yes | read/write | no | Executor → Transactor commit |
| **Action** | no | only via `runQuery`/`runMutation` | yes (fetch, etc.) | Executor (no isolate determinism constraints) |

- Functions live in a `convex/` directory and import from `./_generated/server` and `convex/values` — **this compatibility surface is preserved on purpose** (see [reference/compatibility](../../enduser/reference/compatibility.md)); it is the DX users already trust.
- User code runs in **V8 isolates** for safe multi-tenant determinism. The runtime is abstracted so the *same function* executes under Node, Bun, or a Cloudflare Worker (concave's multi-runtime lesson).
- **Actions are the escape hatch for side effects** (email, third-party APIs, scheduling). They run *outside* the transaction so they can never corrupt the deterministic reactive core — a hard architectural boundary.

## 5. Storage: one narrow seam, many backends

The engine must NEVER import a database driver. All persistence goes through a small, timestamp-aware interface (working name `DocStore` / `DatabaseAdapter`):

- Reads take a `readTimestamp` and return ordered, point-in-time range scans (MVCC).
- Writes carry `previous_revisions` so the transactor can detect OCC conflicts.
- That is essentially the *entire* contract. Anything that can satisfy it is a valid backend.

Planned adapters (in priority order):

| Adapter | Tier | Why |
|---------|------|-----|
| **SQLite (embedded, WAL)** | 0 — lightweight default | Zero-config, in-process, single binary. PocketBase-class footprint. |
| **Postgres** | 1–2 — scalable self-host | Durable, replicas for read-scaling, runs on Railway/Fly/Neon/Docker. |
| **Cloudflare D1 + R2 + Durable Objects** | edge | concave's deploy-anywhere-cheap / scale-to-zero target. |
| *(future)* libSQL/Turso, FoundationDB | edge / extreme scale | Optional; the seam keeps the door open. |

A leak of backend-specific behavior out of the adapter is a **design bug**, not a feature.

## 6. The tiered architecture (how light and scalable coexist)

The same components (transactor, executor, sync tier) are either **co-located in one process** or **split across nodes**. App code is identical across all tiers.

### Tier 0 — Single binary (the default; PocketBase-light)
One executable: transactor + executor + sync tier + dashboard, all in-process, over **embedded SQLite (WAL)**. Subscriptions held in memory. The DB round-trip is an in-process memory access (SpacetimeDB's speed win, for free). Deploy = copy one file / `docker run`. Targets: laptops, a $5 VPS, desktop apps (Electron/Tauri/Electrobun bundling), Cloudflare scale-to-zero.

### Tier 1 — Single node, external Postgres
Same single engine process, Postgres adapter for durability and bigger datasets. Still one writer, still simple ops. The natural "we got traction" step.

### Tier 2 — Distributed (Convex-scalable)
- **Executors** become a stateless, horizontally scaled pool (read-scaling; Convex's "Funrun").
- **Transactor** remains the single logical writer *per shard*; the platform shards by app/namespace so total write throughput scales by adding shards, not by weakening consistency.
- **Sync tier** is its own stateless service holding subscriptions and fanning out deltas — it never touches storage (concave's separate sync tier), so it scales independently and is the realtime fan-out workhorse.
- **Postgres** with read replicas; multi-region by topology config.

> **Promise:** moving Tier 0 → Tier 2 changes deployment config and adapters, **never the `convex/` functions**. That promise is the product.

## 7. Realtime transport

- **WebSocket** is the primary transport (bidirectional, low-latency, what reactive subscriptions want).
- A **binary delta protocol** (compact, send only what changed — SpacetimeDB's BSATN lesson) rather than re-sending whole result sets.
- **SSE / long-poll fallback** for constrained environments (PocketBase proves SSE is enough for many apps and traverses proxies easily).
- The transport is an adapter too, so Cloudflare Durable Objects can back the sync tier at the edge.

## 8. The surrounding platform (later slices — designed, not built yet)

Kept deliberately thin to avoid Supabase's container sprawl. Everything is a module *inside* the engine process at Tier 0, separable at Tier 2 — not a separate mandatory service.

- **Auth** — pluggable providers, JWT sessions; authorization expressed in functions (not a separate policy engine).
- **File storage** — local FS (Tier 0) / S3 / R2 (higher tiers) behind a `BlobStore` adapter.
- **Scheduling & crons & actions** — durable scheduled functions; side effects isolated from the reactive core.
- **Search & vector** — full-text + vector behind adapters (SQLite FTS/`sqlite-vec` at Tier 0; pgvector / Vectorize higher up).
- **Dashboard** — data browser, logs, function runner; served in-process at Tier 0 (PocketBase's instant admin UI).

## 9. What we explicitly will NOT do

- **No 12-container stack.** One engine process with pluggable adapters — not a ring of microservices (anti-Supabase-weight).
- **No single-node ceiling baked in.** Unlike PocketBase, the in-memory/in-process model is the *Tier 0 configuration of a tier-able system*, not the only mode.
- **No data-loss-by-default durability.** We borrow SpacetimeDB's in-memory hot path but keep an honest durable log; async/relaxed flushing is opt-in, not the default.
- **No breaking the Convex authoring surface** for short-term convenience — compatibility is a feature, not an accident.
- **No storage-specific logic in the engine.** The narrow adapter seam is sacred.

## 10. Open questions — mostly answered by the internals extraction

The clean-room extraction in [`internals/`](./internals/README.md) (read from the real `@concavejs/*` interfaces) resolved most of these. Status below; full detail in the linked notes.

1. **`DocStore` interface signature — RESOLVED.** ~15 methods centered on `index_scan(indexId, tableId, readTimestamp, interval, order)`, `write(docs, indexUpdates, conflictStrategy)`, `previous_revisions*` (OCC), `load_documents(tsRange)` (log tailing), globals KV. Data model is an append-only MVCC log of `{ts, id, value, prev_ts}`. See [01-storage](./internals/01-storage.md).
2. **Read-set granularity — DECIDED: table-level first.** concave matches subscriptions at **table granularity for correctness**, with an interval tree as the fine-grained *optimization*. Stackbase ships table-level invalidation in v1; range-precision is a later, measured optimization. See [03-reactivity-sync](./internals/03-reactivity-sync.md).
3. **Conflict-retry — RESOLVED.** 3-phase OCC commit under a per-shard single-writer lock; on `ConflictError` the caller **replays the deterministic UDF**. See [02-transactions-consistency](./internals/02-transactions-consistency.md).
4. **Sync protocol — SHAPE RESOLVED.** Message catalog (`Connect`, `ModifyQuerySet` diff, `Transition`/`StateModification`, `Mutation`/`Action`, journal-based gapless pagination, optimistic-update reconciliation via `requestId` + version brackets). We still own the decision to add a **binary delta encoding** (our divergence from concave's JSON). See [03-reactivity-sync](./internals/03-reactivity-sync.md).
5. **Tier 2 sharding — SHAPE RESOLVED.** `ShardRouter`: consistent hashing (document→committer) + rendezvous hashing (client→sync-node), coordinator ingests load reports and autoscales a TTL-cached shard map. Deferred past Foundation, but the model is known. See [06-runtimes-topology](./internals/06-runtimes-topology.md).
6. **Convex compatibility depth — still ours to decide** per slice (bug-for-bug vs documented differences).

### New open questions surfaced by the extraction (carry into slice specs)

- **Syscall ABI must be fully serializable across a V8 isolate.** concave's `performJsSyscall` (non-JSON) path won't cross a real isolate boundary — we must design ours serializable from day one. See [05-udf-execution](./internals/05-udf-execution.md).
- **Index-key byte format must be re-derived under property tests.** The exact per-type encoding and range-end sentinel aren't in the `.d.ts`; we re-derive an order-preserving codec (`null < bool < number < bigint < string < bytes`) and prove it with property tests. See [04-query-engine](./internals/04-query-engine.md).
- **Write-fanout delivery guarantees** (Tier 0 → in-process subscribers, and cross-process) are unspecified upstream — define ours.

---

**Next:** turn the **Foundation slice** (transactor + executor + SQLite `DocStore` + sync tier + `stackbase dev` CLI + client `useQuery`) into an implementation plan via the brainstorming → writing-plans flow. Tier 0, SQLite, single binary first — it is the smallest thing that proves the core primitive end-to-end.
