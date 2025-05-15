---
title: SpacetimeDB — Architecture Research
status: research
---

# SpacetimeDB — Architecture Research

> Research date: 2025-05-15. Reflects SpacetimeDB ~1.x/2.0-era architecture as documented by Clockwork Labs plus third-party technical reviews. Where sources disagree (notably on concurrency), the disagreement is flagged inline.

## 1. Positioning & one-line thesis

**Thesis:** SpacetimeDB is a relational database that *is also* your application server — you upload your backend logic into the database and clients connect directly to it, eliminating the application-server-to-database network round-trip that dominates latency in conventional stacks.

- Built by **Clockwork Labs** to power their own MMORPG, **BitCraft Online**, whose *entire* backend runs as a single SpacetimeDB database serving thousands of concurrent players.
- Target user: engineers building **realtime multiplayer / collaborative backends** (games first, but pitched broadly at any low-latency realtime app) who otherwise glue together a game server + Redis + Postgres + a pub/sub layer.
- Marketing claim: "100 to 1000x faster than a traditional database" for its target workloads. This is a *stack-level* claim (app+DB co-location), not a raw storage-engine claim — see §3.
- License: **Business Source License 1.1**, converting to **AGPLv3 with a linking exception** after a few years. You can build proprietary apps on it without disclosing your source.

## 2. The core idea: database = application server

The defining architectural move: **there is no separate backend tier.** In a traditional stack, a stateless app server sits between clients and the database, translating requests into SQL over a network socket. SpacetimeDB deletes that tier and moves your logic *inside* the database process.

The model has three primitives, all defined in a **module**:

- **Tables** — your schema / persistent state. State lives *only* in tables.
- **Reducers** — server-side functions that mutate tables transactionally. They are the API: clients "call a reducer" the way they'd call a stored procedure or an RPC. (Think Redux/event-sourcing "reducer": an atomic state transition.)
- **Module** — the deployable unit bundling schema + reducers (+ newer "procedures" and "views"). Compiled to WebAssembly (Rust/C#/C++) or run on V8 (TypeScript). Deployed with `spacetime publish`.

Clients use a generated SDK and do two things: (1) **call reducers** to change state, and (2) **subscribe to queries** to receive a live, automatically-maintained local replica of the rows they care about (§5). There is no REST layer to write, no ORM, no separate websocket server, no cache-invalidation logic — the database synchronizes state to clients itself.

Because logic and data share one address space, a reducer touching the database is a **function call / memory access, not a network query.** That single fact is the entire performance story.

## 3. In-memory architecture & why it's fast  ← MOST IMPORTANT

SpacetimeDB keeps **all application state resident in RAM** and treats disk purely as a durability log (a commit log / WAL), not as the live data store. Reads and writes hit in-memory data structures (pages, indexes, hash tables); the disk is only appended to.

### The dominant win: killing the network round-trip
In a normal stack every reducer-equivalent does N round-trips to the DB over a socket. SpacetimeDB's own benchmark write-up frames the core advantage bluntly: a database round-trip that costs a **minimum of ~200 microseconds over a network** collapses to roughly **~100 nanoseconds** when the "query" is just an in-process memory access — they call it a **~2000x speedup** on that primitive. Everything else compounds from there:

- **No connection pooling** overhead, no per-query auth/handshake.
- **No query serialization/deserialization** on the hot path (no wire protocol between app and storage).
- **No ORM translation** cost.
- **Shorter lock hold times:** in a networked DB, row locks stay held across network latency while a transaction runs; co-location means locks are held for nanoseconds, drastically reducing contention.
- **Cache locality:** the team argues engines like Postgres were architected ~30 years ago for a different cache hierarchy; an in-memory-first design built today exploits modern CPU caches.

### Published numbers (Clockwork Labs "Let's talk benchmarks", banking-transfer workload, power-law key distribution, Intel 14900K class hardware)
| System | Contended TPS (α=1.5) | Uncontended TPS (α=0) |
|---|---|---|
| **SpacetimeDB** | **303,920 ± 4,712** | **279,025 ± 4,763** |
| Bun + Postgres | 2,773 | 10,730 |
| Node + SQLite | 3,188 | — |
| PlanetScale single-node | 235 | — |
| Convex | 127 | — |
| CockroachDB | failed to complete contended test | — |

- SpacetimeDB latency under load: **p50 ≈ 7.39 ms, p99 ≈ 11.7 ms** (contended), versus PlanetScale HA degrading to **p99 ≈ 10,121 ms** under the same contention.
- Cost efficiency claim: **~$3.60/month per kTPS** vs ~$93 (Bun+Postgres) and ~$15,800 (PlanetScale Metal HA).
- These are vendor benchmarks on a workload chosen to favor co-location and in-memory contention handling; treat the *shape* (orders-of-magnitude, especially under contention) as more credible than the exact multipliers.

### The trade SpacetimeDB makes to get this
The serialized write model (§4) is what makes the in-memory path safe without elaborate concurrency control: because writes don't overlap, correctness reasoning is trivial and there's no networked lock contention to fight. The cost is that **single-machine CPU and RAM bound the whole system** (§7). It is *not* "just an in-memory DB" in the Redis-volatile sense — it persists durably (§6) — but it does require the working set to fit in RAM.

## 4. Module / reducer execution model

- **Runtime:** modules compile to **WebAssembly** executed under **Wasmtime** (Rust/C#/C++) or run on **V8** (TypeScript). The host (`ModuleHost`/`HostController`) binds host functions that let WASM read/write tables via a `TxSlot`/`InstanceEnv`, with isolation and security enforced at the boundary.
- **Reducers are transactions.** Each reducer call runs inside one ACID transaction:
  - **Atomicity:** either all table mutations commit or, on any error/exception/panic, the **entire transaction rolls back** — no partial writes.
  - **Isolation:** a reducer never observes another concurrent reducer's mid-flight changes.
  - **Consistency:** a failed reducer leaves state untouched.
- **Serialized writes (the heart of it).** Write transactions execute **one at a time**. A third-party review describes the committed state as effectively wrapped in a single global read-write lock: while a reducer holds the write path, no other reducer writes and (historically) no reader reads. Newer versions add MVCC-style **snapshot reads** so read-only **views** can run concurrently against a consistent snapshot while writes proceed — but *writes themselves remain serialized*. This is a deliberate simplification: linearizability becomes trivial, and the in-memory hot path stays branch-light.
- **No side effects / determinism.** Reducers **cannot make HTTP requests, touch the filesystem, or make syscalls.** They may only modify tables. This keeps them deterministic and replayable — critical because the commit log is replayed on recovery (§6), so a reducer must produce the same effect when replayed. Global/static mutable variables are explicitly **undefined behavior** (modules may run in fresh instances, be hot-swapped, or be replayed); all state must live in tables.
- **Escape hatch — Procedures (beta).** Because the "no I/O" rule is too strict for real apps, **procedures** can do expensive/external work (e.g. HTTP). Reducers can't call procedures directly; they **schedule** them by inserting a row into a schedule table. Note: when a procedure opens a transaction it still acquires the global write path, so long procedures can stall writers.
- **Scheduling:** a `SchedulerActor` polls a `DelayQueue`; scheduled invocations persist in a system table (`ST_SCHEDULED`) so timers survive restarts. This is how you build tick loops / cron-like game logic.
- **Lifecycle reducers:** special reducers fire on `init`, client connect/disconnect, etc.

## 5. Realtime subscription mechanism  ← go deep

This is the second half of the magic: clients don't poll and don't write fetch logic. They **subscribe to SQL queries** and the database maintains a live local mirror of the matching rows, pushing only deltas.

- **What you subscribe to:** a subset of SQL `SELECT` (filters, `WHERE`, and some joins) — "row-level subscriptions." The result set is materialized client-side; the SDK exposes it as a local table you can read synchronously. Subscriptions are deliberately restricted (the query language is narrower than full SQL — e.g. limited/no general aggregation) precisely so the engine can maintain them **incrementally**.
- **How deltas are computed.** Every committed reducer transaction produces a `TxData` delta (inserted/deleted rows). The **SubscriptionManager** maps each client → its compiled query **`Plan`** → its connection sender. On each commit, it runs **incremental evaluation (`eval_incr`)**: rather than re-running every subscription from scratch, it computes which subscriptions are affected by the transaction's row changes and emits only the per-client insert/delete deltas. This is classic incremental view maintenance applied to live multiplayer state.
- **Server-side filtering / security.** **Row-Level Security (RLS)** filters are applied *before* subscription evaluation, so a client only ever sees rows it's authorized to see. Tables are **public or private**; private tables are invisible to client subscriptions/SQL but readable by reducers.
- **The protocol.** Updates ship over a **WebSocket** using the binary protocol **`v1.bsatn.spacetimedb`**. Row data, reducer arguments, and update messages are all encoded in **BSATN** (Binary SpacetimeDB Algebraic Type Notation) — a compact binary serialization of SpacetimeDB's algebraic type system. Internally there's a fast path converting between **BFLATN** (the in-memory flat row layout) and **BSATN** (the wire/storage layout) to avoid per-row reserialization cost; a `BsatnRowListBuilderPool` reuses buffers. Compression and multiple protocol versions are supported.
- **Initial state vs. updates:** on subscribe you get the current matching set once, then a continuous stream of incremental insert/delete deltas as transactions commit. Module hot-swaps preserve active connections and subscriptions (§8), so you can deploy new server code without disconnecting players.

Net effect: the developer writes a `SELECT`, and gets an auto-synchronized, access-controlled, incrementally-updated client cache for free — replacing a hand-rolled pub/sub + cache-invalidation system.

## 6. Storage & durability

SpacetimeDB is **in-memory-first but durable** — explicitly positioned *against* "it's just a cache."

- **Commit log (WAL):** committed transactions are appended to an on-disk **commitlog** by a background **DurabilityWorker**, which `fsync`s segments and advances a `durable_tx_offset`. The data structures in RAM are the source of truth for reads; disk is append-only.
- **Asynchronous durability.** Critically, the WAL flush is **not synchronous with commit** — by default it flushes roughly **every 50 ms**. This is what keeps write latency tiny, but it opens a **data-loss window**: a crash can lose the last <50 ms of committed transactions. A `withConfirmedReads` option lets a read block until its data is disk-synced, but that read may sleep up to ~50 ms — a sharp latency/durability trade.
- **Snapshots.** A **SnapshotWorker** periodically writes full point-in-time snapshots (cited cadence: roughly every **1,000,000 transactions**). Snapshots bound recovery time.
- **Recovery:** on startup the engine restores the **latest valid snapshot**, then **replays the commitlog** from that snapshot's offset forward to reconstruct exact state. Reducer determinism (§4) is what makes replay correct.
- **Ops implication:** production durability depends on automating snapshotting and **WAL segment archival**, and monitoring RAM usage, WAL growth, and recovery time. The Rust crate `spacetimedb-durability` exposes this layer.

## 7. Scalability model

This is the honest weak spot and the natural consequence of §3–4.

- **Single-node, vertical-only.** One SpacetimeDB instance is one machine. There is **no horizontal write scaling, no sharding** of a single database. Your ceiling is the CPU and RAM of one box.
- **RAM-bound dataset.** The entire working set must fit in memory; exceeding RAM is a failure mode, not a spill-to-disk degradation.
- **CPU-bound by serialized writes.** Because write transactions are serialized through a single path (§4), one core effectively gates write throughput; the architecture leans on each transaction being microseconds-short to hit its 300k TPS figures. Concurrent *reads* (views/snapshot reads) scale better than writes.
- **Replication:** optional **followers** with **eventually-consistent** replication (both WAL flushing and replication are async/eventual) — useful for read fan-out and standby, not for strong-consistency horizontal scaling.
- **Recommended scaling pattern:** for room/shard-based games, run **many independent databases** (e.g. one per region/instance/match) orchestrated externally, rather than one giant clustered DB. Sharding is your problem, pushed up to the app/topology layer.
- A true distributed/clustered SpacetimeDB has been discussed as roadmap, but the shipping model is "one fast node + external orchestration."

## 8. Deployment & footprint

- **Single binary.** The whole system — database, app runtime, websocket server — is one executable. The pitch: **no Docker, no Kubernetes, no separate web server, no external dependencies.** `spacetimedb-standalone` runs a node; `spacetime` is the CLI.
- **Hosting options:** self-host the single binary, or use **Maincloud** (Clockwork Labs' managed SpacetimeDB Cloud), where resource limits depend on plan.
- **Hot-swap deploys:** republishing a module **hot-swaps server code while keeping connections and subscriptions intact** — players aren't disconnected, and the engine attempts automatic schema migration preserving existing data.
- **Footprint:** minimal — no sidecars, no broker, no cache tier. The trade is that this one process is stateful and RAM-heavy, so it's not a stateless thing you autoscale; it's a node you size and replicate.

## 9. Developer experience (DX)

- **CLI:** `spacetime` — `spacetime publish` to deploy/update a module, plus generate, logs, SQL console, etc.
- **Write a module:** define `#[table]` structs and `#[reducer]` functions (Rust example; analogous attributes in C#/TS/C++). State = tables, logic = reducers. No SQL DDL files, no migration scripts for the common case (auto-migration on republish).
- **Codegen:** the CLI generates typed **client SDK bindings** from your module schema, so reducer calls and table types are type-safe end-to-end.
- **Module languages:** Rust, C#, TypeScript, C++.
- **Client SDK languages:** TypeScript (React/Next/Vue/Svelte/Angular/Node/Bun/Deno), Rust, C# (incl. **Unity**), C++ (incl. **Unreal Engine**).
- **Client model:** subscribe to a query → read a local synced table; call a reducer like a local async function. The framework handles the websocket, deltas, and local cache.

## 10. The ONE transferable idea

**Co-locate logic with state and push incrementally-maintained query results to clients — i.e. eliminate the app→DB round-trip and the client poll loop, not just optimize them.** The 2000x primitive (200 µs network query → 100 ns memory access) is the lever; incremental subscriptions (`eval_incr` over committed deltas) are how you turn that into a realtime client experience.

What's **adoptable** without going all-in on SpacetimeDB:
- **Move hot read/write paths in-process with state.** Even partially — caching authoritative state in the app process and treating the DB as a durability log behind an async WAL-style flush — captures much of the latency win. (Cloudflare Durable Objects and actor/grain systems embody the same "state + logic co-located, single-writer" idea.)
- **Incremental view maintenance for realtime fan-out.** Compute per-subscription deltas from a transaction changelog instead of re-querying; ship a compact binary delta over websockets. This is the single most copyable mechanism for a fast realtime backend and is orthogonal to the rest.
- **Single-writer-per-shard serialization.** Serializing writes per entity/room makes correctness trivial and removes lock contention — viable if you shard so each shard's writes are short.

What's **too radical / not free:** running arbitrary user code inside the DB transaction with a no-I/O determinism contract, the global-write-serialization model, and accepting a RAM-bound single node. Borrow the *pattern* (co-location + incremental subscriptions + async durability) rather than the *literal monolith*, unless your workload genuinely fits one box.

## 11. Weaknesses / things to avoid

- **Serialized writes = single-CPU write ceiling.** Great for short transactions; a single slow reducer (or beta procedure holding a transaction) stalls all writers. A third-party reviewer notes `parking_lot` RWMutex fairness can inject reader delays up to ~0.5 ms under write-heavy load.
- **RAM-bound, single-node.** No sharding within a database; exceeding RAM is fatal, not graceful. Horizontal scale is a manual multi-database topology problem.
- **Async durability data-loss window.** Default ~50 ms WAL flush means a crash can lose recently-"committed" transactions unless you opt into confirmed reads (which add up to ~50 ms latency). Don't use the default posture for money-movement or anything requiring zero RPO.
- **No I/O in reducers.** External calls require the beta **procedures** path with scheduling indirection; ergonomically awkward and a poor fit for workloads dominated by external/LLM calls (one reviewer argues it's actively hostile to agent-style code).
- **Vendor benchmarks.** The 100–1000x / 300k TPS numbers come from Clockwork Labs on a workload tuned to their strengths; trust the order-of-magnitude under contention more than the exact figures, and benchmark your own workload.
- **Maturity / lock-in.** BSL license, evolving internals (reducers vs procedures vs views still settling), MVCC-read behavior changing across versions, and trade-offs not always documented up front. One review pointedly compares the "oversold benchmarks, undisclosed trade-offs" launch posture to early MongoDB.
- **Not a general-purpose OLAP/analytics DB.** Restricted subscription query language (limited aggregation/joins) by design; it's an operational realtime store, characterized by one reviewer as "a more powerful Redis" than a drop-in Postgres.

## 12. Sources

- What is SpacetimeDB — https://spacetimedb.com/docs/intro/what-is-spacetimedb/
- FAQ — https://spacetimedb.com/docs/intro/faq/
- Reducers overview — https://spacetimedb.com/docs/functions/reducers/
- The Database Module — https://spacetimedb.com/docs/databases/
- BSATN data format — https://spacetimedb.com/docs/bsatn/
- HTTP / WebSocket protocol (`v1.bsatn.spacetimedb`) — https://spacetimedb.com/docs/http/database/
- "Let's talk benchmarks" (TPS/latency/cost numbers) — https://spacetimedb.com/blog/benchmarking
- GitHub: clockworklabs/SpacetimeDB — https://github.com/clockworklabs/SpacetimeDB
- DeepWiki: System Architecture Overview — https://deepwiki.com/clockworklabs/SpacetimeDB/1.1-system-architecture-overview
- "SpacetimeDB: a short technical review" (strn.cat — concurrency, WAL, scaling critique) — https://strn.cat/w/articles/spacetime/
- `spacetimedb-durability` crate — https://docs.rs/spacetimedb-durability/latest/spacetimedb_durability/
- `spacetimedb-table` crate (BFLATN/BSATN) — https://docs.rs/spacetimedb-table/latest/spacetimedb_table/
