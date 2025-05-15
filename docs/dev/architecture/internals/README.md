---
title: Engine Internals — Clean-Room Extraction (Index)
status: extracted
---

# Engine Internals — Clean-Room Extraction

Ground-truth architecture notes, written **in our own words** from studying the published `@concavejs/*` packages (compiled `dist/` + `.d.ts`). This is **clean-room reference**: we describe contracts and data flow to inform our *own* implementation. We do **not** copy concave's code (it is FSL-1.1-Apache-2.0; see [`.reference/README.md`](../../../../.reference/README.md)).

> These notes are *more authoritative than the docs* — they come from the real interfaces. Where they refine the [system design](../system-design.md), the system design's "open questions" have been updated accordingly.

## The seven subsystems

1. [Storage Layer & Document Identity](./01-storage.md) — the `DocStore` adapter, the MVCC document-log, the SQLite seam, table registry, ID codec.
2. [Transactor, OCC & Reactive Invalidation](./02-transactions-consistency.md) — single-writer commit pipeline, read/write sets, OCC validation, read-your-own-writes, the invalidation bridge.
3. [Reactive Subscriptions & Sync Protocol](./03-reactivity-sync.md) — the separate sync tier, subscription matching, the interval tree, the WebSocket protocol.
4. [Query Engine](./04-query-engine.md) — order-preserving index-key codec, query planning, how scans become read-set ranges, stable pagination.
5. [UDF Execution](./05-udf-execution.md) — the host/guest split, the syscall ABI, determinism enforcement, the executor seam.
6. [Runtimes & Deployment Topology](./06-runtimes-topology.md) — multi-runtime abstraction, the embedded Tier 0 binary, Cap'n Web transport, Tier 2 sharding/autoscaling.
7. [Platform Services](./07-platform-services.md) — auth, scheduler/crons, system tables, HTTP, blob/search/vector adapter seams, errors.

## The 10 highest-leverage facts (read these even if nothing else)

1. **The data model IS an append-only MVCC log.** A `DocumentLogEntry` is `{ts, id, value|null-tombstone, prev_ts}`; per-document backward `prev_ts` links form a revision chain. Snapshot reads = "newest revision with `ts <= readTimestamp`." Everything (consistency *and* reactivity) is built on this one structure.

2. **The storage seam is ~15 methods, and it's narrow on purpose.** `index_scan` (ordered point-in-time range read), `write` (atomic batch of doc revisions + index updates), `previous_revisions*` (OCC chain lookup), `load_documents` (timestamp-range log tailing for change feeds), a globals KV, and `count/get/scan`. Anything that can do an *ordered range scan at a timestamp* is a valid backend. **This is the keystone of deploy-anywhere.**

3. **One SQLite layout backs many logical tables.** Three physical tables — `documents`, `indexes`, `persistence_globals` — with logical tables discriminated by id columns and versioned by `ts`. The abstract `BaseSqliteDocStore` sits over a tiny platform `SqliteAdapter` (exec/prepare/transaction); Node/Bun/D1 are thin concrete adapters.

4. **Developer-facing IDs are self-validating & order-preserving:** `varint(tableNumber) + internalId(16 random bytes) + fletcher16 checksum`, rendered in Crockford Base32. Compact (~31–37 chars), client-validatable without a round-trip. (`tableNumber`: system 1–9999, user tables 10001+.)

5. **OCC is a 3-phase commit under a per-shard single-writer lock:** validate the read set against current state via the `prev_ts` chain + phantom/scan-range checks → allocate ONE commit timestamp → atomically apply staged docs + index updates. Conflict ⇒ `ConflictError` ⇒ caller **replays the deterministic UDF** (safe precisely because functions are deterministic).

6. **Reactivity reuses the OCC read/write sets for free.** The commit emits the written ranges; the sync tier intersects them against each live subscription's recorded read ranges; any overlap marks that subscription stale and triggers recompute + push. No separate cache-invalidation system.

7. **Start table-level, optimize to ranges later.** concave's `SubscriptionManager` matches at **table granularity for correctness**, with the **interval tree** (augmented BST keyed on range start, caching subtree-max end, O(log n + k) overlap query) as the *fine-grained optimization*. → **Stackbase ships table-level invalidation first; range-precision is a measured optimization, not a v1 requirement.** This is the single most important sequencing decision the extraction gave us.

8. **The query engine's power is an order-preserving binary index-key codec.** Value tuples encode with 1-byte type tags following Convex's total order (`null < bool < number < bigint < string < bytes`) so *byte comparison == logical sort order*. The planner pushes leading-equality + one inequality into a single `[start, end)` scan; residual `.filter()` predicates run as post-filters. Cursors carry `(indexKey, _id)` so pagination is stable under concurrent writes.

9. **User code touches the engine ONLY through a versioned, serialized syscall ABI.** A per-invocation kernel ledgers every read/write range, auth access, and scheduled call. Determinism is enforced by *environment profiles*: queries/mutations get a **seeded PRNG** wired into `Math.random`/`crypto` and **no clock/fetch/timers**; actions get the real ones. ⚠️ **Risk flagged:** concave's `performJsSyscall` (non-JSON) path won't survive a real V8 isolate boundary — we must design our syscall ABI to be fully serializable across the isolate from day one.

10. **The tiers are real and already shaped in the code.** `runtime-base` factors the engine behind abstract bases; **Tier 0** = `EmbeddedRuntime` (transactor+executor+sync+HTTP in one process, client connects via an in-memory `LoopbackWebSocket`, `write-fanout` to in-process subscribers); **Tier 2** = `ShardRouter` (consistent hashing doc→committer, rendezvous hashing client→sync-node) + a coordinator that ingests load reports and autoscales a TTL-cached shard map. Our tiered design isn't aspirational — it mirrors a proven shape.

## What this changes for the build

- The **Foundation slice** is now precisely scoped: embedded Tier 0 runtime + SQLite `DocStore` (3-table layout) + MVCC log + single-writer transactor with 3-phase OCC + **table-level** invalidation + a minimal sync protocol over a loopback/WS transport + the index-key codec + a V8-isolate executor with a serializable syscall ABI + the `stackbase dev` CLI + a client `useQuery`.
- Range-precise invalidation, sharding (Tier 2), search/vector, and multi-runtime hosts are **explicitly deferred** to later slices — the extraction proves they layer on without disturbing the core.
