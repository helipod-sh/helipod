---
title: Foundation Slice — Implementation Plan
status: implemented — M0–M11 built + hardened (historical plan of record)
date: 2025-05-15
audience: engineering (internal)
---

# Foundation Slice — Implementation Plan

Companion to the [design spec](./2025-05-15-foundation-design.md). Ordered milestones; each is **independently verifiable** (has its own acceptance test) and respects the dependency DAG. Build strictly in order; later milestones may begin once their listed deps' interfaces are frozen.

**Conventions.** TypeScript, pnpm workspace, ESM, `vitest`. Every milestone freezes its public interfaces (downstream depends on them) and ships with passing tests + types. "Frozen" = the canonical types from design §3.1 live here and nowhere else.

---

## M0 — Monorepo scaffold + values + errors
- **Build:** pnpm workspace; `tsconfig` base + per-package; `vitest`, lint, build (tsup/`tsc`) wiring; root `stackbase` bin stub. Packages `@stackbase/values` (Value system, `v`, `defineTable/defineSchema`, `compareValues`, `convexToJson`, `GenericId`) and `@stackbase/errors` (`StackbaseError` hierarchy, `toStackbaseError`, `getHttpStatus`).
- **Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `packages/values/*`, `packages/errors/*`.
- **Freeze:** `Value`, `JSONValue`, `Id/GenericId`, `compareValues`, `v`, `defineTable/defineSchema`, `StackbaseError` + subclasses.
- **Acceptance:** `pnpm build && pnpm test` green; `compareValues` total-orders across all value types (property test); `v.object({...})` validates + round-trips through `convexToJson`.
- **Deps:** none.

## M1 — Index-key codec + document identity
- **Build:** `@stackbase/index-key-codec` (`encodeIndexKey`, `compareIndexKeys`, `KeyRange`, `RangeSet`, `SerializedKeyRange`, `Cursor`/`IndexCursor`, `Keyspace`, `WriteInvalidation`) and `@stackbase/id-codec` (`InternalDocumentId`, base32+fletcher16+varint `DocumentId` codec, `TableRegistry`, `ShardId`/`DEFAULT_SHARD`, `ShardKeyResolver`, **declare** `ShardRouter`+`SimpleShardRouter`).
- **Freeze:** all key/range/cursor types (canonical per design §3.1); identity + shard types.
- **Acceptance (property tests, load-bearing):** `compareIndexKeys(encodeIndexKey(a), encodeIndexKey(b)) === compareValues(a,b)` over generated tuples spanning `null<bool<number<bigint<string<bytes`; `decodeDocumentId(encode(...))` round-trips and a 1-bit corruption fails `verifyFletcher16`; `RangeSet` overlap/`rangesOverlap` correctness.
- **Deps:** M0.

## M2 — SQLite DocStore (MVCC)
- **Build:** `@stackbase/docstore` (the `DocStore` contract + `DocumentLogEntry`/`LatestDocument`/`TimestampOracle`/`DatabaseIndexUpdate`) and `@stackbase/docstore-sqlite` (3-table layout `documents`/`indexes`/`persistence_globals`; `DatabaseAdapter` + `NodeSqliteAdapter` (node:sqlite/better-sqlite3, WAL); `SerializedTransactionRunner`).
- **Freeze:** `DocStore`, `DocumentLogEntry`, `LatestDocument`, `TimestampOracle`, `DatabaseAdapter`. `shardId?` param present on `write` (ignored at Tier 0).
- **Acceptance:** write doc revisions then `get`/`index_scan` at varying `readTimestamp` returns the correct point-in-time version; `prev_ts` chains correct; `previous_revisions` returns expected; `load_documents(tsRange)` tails in order; tombstones (`value=null`) hide rows.
- **Deps:** M1.

## M3 — Transactor + OCC
- **Build:** `@stackbase/transactor` (`SingleWriterTransactor`, `runInTransaction`, `UncommittedWrites` (read-your-own-writes), 3-phase commit, `previous_revisions` validation, `CommitResult`+`OplogDelta`, `WriteFanout` interface, `TransactionHeadroom`, `OccConflictError`+retry policy). One `TimestampOracle`, one shard `"default"`.
- **Freeze:** `Transactor`, `CommitResult`, `OplogDelta`, `WriteFanout`, `ConflictError`. `shardId` on `CommitResult`/`OplogDelta`.
- **Acceptance:** two concurrent mutations reading+writing the same key → exactly one commits, the other gets `OccConflictError` and **deterministic replay succeeds**; commit emits an `OplogDelta` with the correct `written_ranges`/`written_tables`/`shard_id`; headroom limit trips `HeadroomExceededError`.
- **Deps:** M1, M2.

## M4 — Query engine
- **Build:** `@stackbase/query-engine` (`buildQueryPlan` → table-scan/index-range plans; `QueryRuntime` driving `DocStore.index_scan` and **recording read-set intervals into a `RangeSet`**; filters/post-filters; `paginate` with `(indexKey,_id)` `IndexCursor` + `PaginationJournal`; `IndexManager` maintaining index updates on write).
- **Freeze:** `QueryPlan`, `QueryRuntime`, `IndexCursor`, `QueryJournal`, `IndexManager`.
- **Acceptance:** an indexed query returns rows in index order and **records exactly the scanned interval** as its read-set; `paginate().order("desc")` is stable (no skip/dup) while new rows are inserted at the head between pages; `withIndex` equality+range pushes into one `[start,end)` scan, residual `.filter` runs as post-filter.
- **Deps:** M1, M2 (uses M3's `TransactionContext` for reads inside mutations).

## M5 — UDF executor + syscall ABI
- **Build:** `@stackbase/executor` (`UdfExec` + `UdfExecutionAdapter`; `UdfKernel`+`KernelContext` ledgering reads/writes/scheduled calls; `SyscallRouter` with **`(ctx, argJson:string)→Promise<string>`** handlers for db/query/schedule/identity; `UdfEnvironmentProfile` + frozen QUERY/MUTATION/ACTION/HTTP profiles; `SeededRandom`; module loader/analysis). Ship the **inline `SerializedUdfExecutor`** first (same `UdfExec` contract; true V8 isolates are a drop-in follow-up — see design §12 open decision 1).
- **Freeze:** `UdfExec`, `UdfExecutionAdapter`, `SyscallRouter`, `SyscallHandler` (string ABI), `UdfEnvironmentProfile`.
- **Acceptance:** a query and a mutation execute purely via string syscalls and produce correct results + a recorded read/write set; `Math.random()` in a query is seeded/deterministic and `Date.now()`/`fetch` are absent (profile-enforced); an action gets native capabilities; a mutation that conflicts replays deterministically (ties M3).
- **Deps:** M3, M4.

## M6 — Reactive sync tier
- **Build:** `@stackbase/sync` (`SyncProtocolHandler`; `ClientMessage`/`ServerMessage` unions **incl. `Broadcast` kind** + `JsonServerMessageCodec`; `SubscriptionManager` with `MatchMode="table"` default (interval tree present, `"range"` reserved); `QueryCache`+`CacheStrategy` keyed by content-addressed `QueryHash`; `SyncSession` with `SessionBackpressureController`/`SessionHeartbeatController`/rate-limit/sub-cap; `EphemeralBroadcast`/`PresenceChannel` seam; `ChangeStreamConsumer`; **declare** `ShardRouter`/`SyncShardMap`/`SyncNodeLoadReport`). Talks only to abstract `SyncWebSocket`/`SyncUdfExecutor`.
- **Freeze:** `SyncProtocolHandler`, `ServerMessage`/`ClientMessage` + codec, `SyncWebSocket`, `SyncUdfExecutor`, `SubscriptionManager`, `StateVersion`.
- **Acceptance:** over a mock `SyncWebSocket`: `ModifyQuerySet(add)` returns a `Transition` with the query result; a `notifyWrites` whose tables intersect the sub's read-set pushes a recomputed `Transition` advancing `startVersion→endVersion`; a simulated dropped frame (version gap) makes the client-side reducer request a **full resync**; ephemeral `Broadcast` reaches local subscribers **without** touching the transactor.
- **Deps:** M3, M4, M5.

## M7 — Embedded runtime (Tier 0 composition)
- **Build:** `@stackbase/runtime-embedded` (`EmbeddedRuntime`/`RuntimeHost` wiring DocStore+Transactor+QueryRuntime+UdfExec+SyncProtocolHandler; `LoopbackWebSocket`/`LoopbackBridge` + `createTransport()`; `EmbeddedWriteFanout` (in-mem adapter) bridging `OplogDelta`→`notifyWrites` via `ChangeStreamConsumer`; `HttpHandler`; `SerializedUdfExecutor` host).
- **Freeze:** `EmbeddedRuntime`, `RuntimeHost`, `createTransport()`, `EmbeddedWriteFanout`/adapter.
- **Acceptance:** an in-process unmodified client (`createTransport()`) subscribes to a query, a mutation runs, and the client receives the reactive update — **fully in one process, no network**. Write-fanout is the in-memory adapter; swapping the adapter is a no-op to app code.
- **Deps:** M2–M6.

## M8 — Schema + codegen
- **Build:** `@stackbase/codegen` (`generateApi`/`generateDataModel`/`generateServer`; `validatorToTsType`; runtime + static schema/manifest sources; `_generated/` writer). Surfaces `ShardKeyDefinition` in the schema (the data-model shard-key seam).
- **Freeze:** `generateAll`, `CodegenInput/Options`, generated `_generated/{api,dataModel,server}.d.ts` shape.
- **Acceptance:** given a sample `schema.ts` + analyzed modules, codegen emits typed `api`, `Doc<>`/`Id<>`, and `query/mutation/...` wrappers that typecheck against `@stackbase/values`; round-trips a validator → TS type.
- **Deps:** M0 (values); independent of M2–M7, can run in parallel after M0.

## M9 — `stackbase dev` CLI
- **Build:** `@stackbase/cli` (`devCommand`: watch `convex/`, bundle+analyze, run codegen, boot `EmbeddedRuntime`, serve loopback+HTTP; push pipeline; `DiagnosticReporter`; `EmbeddedDeployTarget`).
- **Freeze:** `stackbase dev`/`stackbase codegen` CLI surface.
- **Acceptance:** `stackbase dev` in a sample project boots the engine, generates `_generated/`, and **hot-pushes** an edited function (watch → rebuild → re-register) with a visible diagnostic; `_dashboard` HTTP responds.
- **Deps:** M7, M8.

## M10 — Client SDK + React `useQuery`
- **Build:** `@stackbase/client` (+ `/react`): `StackbaseClient` over `ClientTransport`; `LocalSyncState`/`OptimisticQueryResults`; `useQuery`/`useMutation`/`useAction`/`usePaginatedQuery`; reconnect/resubscribe; **version-gap → full resync** behavior.
- **Freeze:** `StackbaseClient`, hooks, `OptimisticUpdate`.
- **Acceptance:** against the embedded runtime, `useQuery` renders, updates reactively on a mutation, and an optimistic update applies then reconciles to the authoritative result; a forced version gap triggers a clean resync with no duplicate/lost rows.
- **Deps:** M6, M7.

## M11 — End-to-end acceptance: the chat app
- **Build:** `examples/chat` — `convex/schema.ts` (`conversations`, `messages` with `by_conversation` index and **`conversationId` as the shard key**, `readWatermarks`), `convex/messages.ts` (`list` paginated query, `send` mutation), a minimal React client.
- **Acceptance (the slice is "done" when this passes):**
  1. Two clients subscribe to `messages.list({conversationId})`; client A `send`s → **both** see the new message pushed reactively (B via `Transition`, A via `MutationResponse`).
  2. The `conversationId` shard key threads through `write`→`Transactor`→`CommitResult` (assert `shardId` present, `"default"` at Tier 0).
  3. `usePaginatedQuery` scrolls history stably while new messages arrive at the head (no skip/dup).
  4. An ephemeral "typing" `Broadcast` reaches the other client **without** creating a `DocumentLogEntry` or hitting the transactor (proves seam #5 wired).
  5. The whole thing runs from `stackbase dev` (one process, one SQLite file) and from a `docker run` of the same artifact.
- **Deps:** M9, M10 (and everything transitively).

---

## Parallelization
M8 (codegen) can proceed in parallel after M0. M1 (codec + id) can split into two parallel tracks. M5/M6 depend on M3/M4 but M6's protocol/codec/session sub-parts can be built against mocks before M5 lands. Otherwise the spine M0→M1→M2→M3→M4→M5→M6→M7→M9/M10→M11 is largely serial by dependency.

## Deferred past Foundation (do NOT build here)
Range-precise invalidation · Tier 2 distributed sharding + sync fleet + coordinator (`ShardRouter`/`SyncShardMap` stay declared-only) · Postgres `DocStore` adapter · ephemeral/presence **implementation** beyond the in-process seam · auth · file storage · search/vector execution · multi-runtime hosts (Bun/CF) · binary wire codec · retention/compaction policy.

## Pre-build gate (historical — resolved)
This slice has been **built (M0–M11) and hardened** — see [`../../dev/architecture/hardening-2025-05-15.md`](../../dev/architecture/hardening-2025-05-15.md). The 4 open decisions from design §12 were resolved during implementation: **executor inline-first** (isolates later), **separate packages**, **Node + Bun (Bun primary)**, **MIT** license. The originally-planned *design-level* `plan-foundation` adversarial re-run was **superseded** by the code-level hardening review and was not run.
