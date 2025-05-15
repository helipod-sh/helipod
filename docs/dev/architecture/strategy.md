---
title: Build Strategy — What We Take From Each, and Where We Diverge
status: decided
---

# Build Strategy — "Are we just cloning concave?"

**No.** Concave is our **engine skeleton** (it's the only reference that is literally Convex-compatible + multi-runtime, and we have its real interfaces). But we deliberately **reshape its priorities and fix its weaknesses** using everything we learned from Convex, SpacetimeDB, Supabase, and PocketBase. Stackbase = concave's proven engine shape + a lightweight-first, fast-realtime, deploy-anywhere reorientation.

## What we take from concave (the skeleton — keep)

- The **MVCC document-log** data model (`{ts, id, value, prev_ts}`) and the **narrow `DocStore` seam** (~15 methods). This is the keystone of deploy-anywhere.
- **3-phase OCC** under a single-writer lock with deterministic-UDF replay on conflict.
- **Read/write-set reactivity** (Convex's idea, concave's implementation): one mechanism for consistency *and* live queries.
- **Convex API compatibility** (`convex/` functions, validators, generated client) — the DX users already trust.
- The **tiered runtime shape** (embedded → process-split → sharded) and **pluggable adapters** (docstore/blobstore/transport).

## Where the other systems change the plan (not decoration — real divergences)

| From | What we adopt | How it changes concave's plan |
|------|---------------|-------------------------------|
| **PocketBase** | Single-binary, embedded-SQLite, batteries-included (auth+files+dashboard in one process), instant admin UI | **We invert concave's priority order.** concave is Cloudflare/edge-first; **Stackbase is single-binary + Docker FIRST**, edge later. Tier 0 is the *default product*, not a fallback. |
| **SpacetimeDB** | **Binary delta wire protocol**, in-memory hot working set, incremental subscription eval, single-writer serialization | concave pushes **JSON** over the wire and re-runs whole queries. We diverge: **binary deltas + send-only-what-changed** is how we beat concave on realtime latency/throughput. |
| **Supabase** | Postgres as a **first-class scale spine** (not just one adapter among many); "schema as source of truth" feeding codegen/types | We make **SQLite ↔ Postgres the canonical scaling path** with one well-tested seam. We explicitly **reject** Supabase's weight (no 12 containers, no PostgREST/RLS/Kong). |
| **Convex** | The **DX bar**: codegen quality, end-to-end types, reactive `useQuery`, `dev` watch loop | We hold ourselves to *Convex-grade DX*, not just "it works." DX is the product, not a finishing touch. |

## The locked divergences from concave (decided)

1. **Lightweight-first, not edge-first.** Default = one binary + embedded SQLite + `docker run`. (PocketBase lesson.)
2. **Binary delta sync protocol**, not JSON. (SpacetimeDB lesson; concave's JSON flagged in [internals/03](./internals/03-reactivity-sync.md).)
3. **Fully serializable syscall ABI across a real V8 isolate** from day one. (concave's `performJsSyscall` non-JSON path won't cross an isolate — [internals/05](./internals/05-udf-execution.md).)
4. **Table-level invalidation first**, range-precision as a measured optimization. (Confirmed from concave; we commit to the simpler v1.)
5. **SQLite + Postgres are the two blessed adapters**; everything else (D1/R2/Durable Objects) is community/optional. (We focus the seam instead of spreading it thin.)
6. **Genuine open-source license** (MIT/Apache), clean-room implemented — *not* concave's FSL.
7. **Bun is the primary runtime** (decided 2025-05-15) — server + dev DX + the single-binary distribution via `bun build --compile` (the real PocketBase-lightweight story). The engine stays **runtime-agnostic** behind the `DatabaseAdapter` / runtime seams; **Node is fully supported** (all npm packages run on Node; `NodeSqliteAdapter` is first-class). Validated: the same `SqliteDocStore` passes its contract under both `BunSqliteAdapter` (Bun) and `NodeSqliteAdapter` (Node).

## The scalability mandate (explicit)

Stackbase must serve the **entire spectrum on the same app code**: from **PocketBase-class tiny apps** (one binary, embedded SQLite, zero-config, $5 VPS) up to **WhatsApp-class realtime apps** (hundreds of millions of concurrent connections, massive message throughput, group fan-out, presence/typing/read-receipts, infinite history). Tier 0 implements the small end; the seams must make the large end reachable **without rewriting app code or the core engine**. Three seams are non-negotiable from day one: a **shard/namespace key** in the data model (a conversation is a shard → single-writer-*per-shard* = unbounded write scale), a **connection-sharded sync fleet** behind the sync interface, and an **ephemeral broadcast path that bypasses the durable log** (presence/typing must not be durable transactions). Full detail in [`scalability-spectrum.md`](./scalability-spectrum.md).

## What we are NOT doing

- Not forking/porting concave's code (FSL; clean-room only).
- Not edge/Cloudflare-first (it becomes an optional target, not the center).
- Not Supabase-style microservice sprawl.
- Not chasing range-precise invalidation, sharding, or multi-runtime hosts in v1 — they layer on later (the internals prove they can).

## The plan, concretely (build order)

Same 6 slices as `CLAUDE.md`, now informed by the extraction. Each slice: **brainstorm → spec (`docs/superpowers/specs/`) → writing-plans → implement → verify**, Tier 0 / SQLite / single-binary first.

1. **Foundation** ← next. Embedded Tier 0 runtime + SQLite `DocStore` (3-table MVCC) + single-writer 3-phase OCC + table-level invalidation + minimal sync (loopback/WS) + order-preserving index-key codec + V8-isolate executor (serializable syscalls) + `stackbase dev` CLI + client `useQuery`. The smallest thing that proves the reactive core end-to-end.
2. Dashboard · 3. Auth · 4. File storage · 5. Actions + scheduler/crons · 6. Production deploy (Docker → distributed).

Speed (binary protocol, in-memory hot path) and scale (Postgres adapter, sharding) are folded into the relevant later slices once the core is proven — not bolted on, but not premature either.
