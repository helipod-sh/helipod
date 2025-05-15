---
title: Reference Systems — Comparison & Transferable Ideas
status: research
---

# Reference Systems — Comparison & Transferable Ideas

This synthesizes the five architecture briefs in this folder ([convex](./convex.md), [concave](./concave.md), [spacetimedb](./spacetimedb.md), [supabase](./supabase.md), [pocketbase](./pocketbase.md)) into a single decision-grade comparison. It is the input to [the Stackbase system design](../architecture/system-design.md).

## The four goals (your brief)

| Goal | Best exemplar | What we borrow |
|------|---------------|----------------|
| **Convex-like DX** | Convex | Reactive typed queries, `convex/` functions, codegen, "it just updates" |
| **PocketBase-like lightweight** | PocketBase | Single binary, embedded SQLite, zero-config, in-process everything |
| **SpacetimeDB-like fastest realtime** | SpacetimeDB | In-memory hot path, incremental subscription eval, binary deltas, single-writer serialization |
| **concave-like deploy-anywhere / lowest cost** | concave | Storage/transport/execution as swappable adapters; one app, many runtimes |
| *(implicit)* **scalable** | Convex + Supabase | Stateless read-scaling executors; single logical writer; sync tier separate from storage |

## Comparison matrix

| Dimension | Convex | concave | SpacetimeDB | Supabase | PocketBase |
|-----------|--------|---------|-------------|----------|------------|
| **Core thesis** | Reactive DB + TS functions | Convex-compatible runtime, any host | DB *is* the app server | Postgres + microservices ring | Single-file backend |
| **Language (engine)** | Rust | TypeScript | Rust | Postgres + Elixir/Go/etc. | Go |
| **Storage** | Log + MV indexes over SQLite/PG/MySQL | Narrow timestamp-aware `DocStore` (SQLite/D1/R2/DO/PG) | In-memory + commit log/WAL | Postgres | Embedded SQLite (WAL) |
| **Function/exec model** | V8 isolates; query/mutation/action; deterministic txn | Same as Convex, multi-runtime (CF/Bun/Node) | WASM "reducers", deterministic | SQL + RLS; PostgREST; Edge Functions | Go framework + goja JS hooks |
| **Reactivity primitive** | Read-set vs write-set over ordered log | **Range-overlap** of read/write ranges; sync tier separate | Incremental query eval (`eval_incr`) over row deltas | Postgres WAL → Realtime server → WS | In-process SSE broadcast |
| **Transport** | WebSocket | WebSocket (Durable Objects) | WebSocket + BSATN binary | WebSocket | **SSE (HTTP)** |
| **Consistency** | Serializable, single-writer | Snapshot (MVCC/OCC) | Serializable, single-writer | Postgres MVCC | SQLite txn |
| **Scale-out (writes)** | Single writer (hard ceiling) | Single transactor per shard; shardable | Single node (distributed roadmap) | Single primary (no sharding) | **None (single node)** |
| **Scale-out (reads)** | Stateless executors (Funrun) | Stateless executors + replica reads | In-process | Read replicas + pooler | Vertical only |
| **Self-host footprint** | Backend binary + a SQL store | 1 process → edge fleet; 14MB desktop bundle | Single binary | **~12 containers, 6+ runtimes** | **1 binary, ~tens of MB** |
| **Realtime scaling weakness** | Write ceiling | DO/topology complexity | Single-node memory bound | WAL realtime single-threaded | Broker can't span instances |
| **DX standout** | Codegen + reactive `useQuery` | Convex-compat, multi-target deploy | Direct client→DB, no backend | Schema-is-API, RLS, Studio | Admin UI, instant |

## The ONE transferable idea from each

1. **Convex — the reactivity primitive.** A query records its **read set as precise index ranges**; a mutation commits a **write set**; a subscription re-runs only when a committed write set **overlaps** its read set. One mechanism = OCC serializability *and* realtime, with zero manual cache invalidation. **This is the spine of Stackbase.**

2. **concave — the narrow storage seam.** Push MVCC/OCC into a tiny timestamp-aware adapter interface (reads carry a `readTimestamp`, writes expose `previous_revisions`). Any store that can do an *ordered point-in-time range scan* qualifies — SQLite, Postgres, D1, Durable Object storage. **This is what makes "deploy anywhere" real**, and it makes the sync tier storage-independent (it works on ranges, never touches the DB).

3. **SpacetimeDB — collapse the hops.** The dominant backend latency is the networked DB round-trip (~200µs); doing it **in-process** makes it ~100ns. Keep the hot working set in memory, serialize writes through a single transactional path (concurrency control becomes trivial), evaluate subscriptions **incrementally** over each transaction's row deltas, and push **compact binary diffs** — never poll. **This is our speed playbook** (and embedded SQLite in Tier 0 already gives the in-process win for free).

4. **PocketBase — the single binary.** Database, API, realtime, auth, files, and dashboard in **one statically-linked executable** with in-process SQLite (WAL). Zero external services = zero seams = trivial deploy. **This is our lightweight default tier.**

5. **Supabase — schema as the single source of truth** (auto API, types, realtime, authz all *derived* from one declarative artifact) — **but learn from its weight**: ~12 containers and a single-threaded WAL realtime path are exactly what a "lightweight, deploy-anywhere" system must NOT become.

## Key tensions to resolve (handed to the system design)

- **Lightweight (1 binary, in-memory subs) vs scalable (separate sync tier, many nodes).** → Resolved by a **tiered architecture** where the *same app code* runs in-process (Tier 0) or split into executor + transactor + sync tiers (Tier 2). The split is a deployment choice, not a rewrite.
- **In-memory speed (SpacetimeDB) vs durability/cost.** → Adopt the in-memory hot path + incremental push, but keep an honest durable log; don't ship SpacetimeDB's async-flush data-loss window as a default.
- **Single-writer simplicity vs write throughput.** → Single logical writer per *shard*; the deployment shards by app/namespace. Most workloads never need more than one.
- **Convex compatibility vs our own ambitions.** → Keep the `convex/` function authoring surface compatible (the DX users already love), but own the engine, adapters, sync protocol, and deploy story.
