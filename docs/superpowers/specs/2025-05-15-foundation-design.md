---
title: Foundation Slice — Design Spec
status: implemented + hardened (built as M0–M11; the code is the source of truth)
date: 2025-05-15
audience: engineering (internal)
---

# Foundation Slice — Design Spec

> **Provenance & status.** This spec was synthesized from the 12 component designs in [`../../dev/architecture/foundation/`](../../dev/architecture/foundation/) and the [scalability spectrum](../../dev/architecture/scalability-spectrum.md) (produced by the `plan-foundation` workflow). The slice has since been **fully implemented (M0–M11)** under `packages/`, with a runnable example in `examples/chat`. The originally-planned *design-level* adversarial pass was **superseded** by an adversarial review of the **built code** (19 findings, 16 fixed) — see [`../../dev/architecture/hardening-2025-05-15.md`](../../dev/architecture/hardening-2025-05-15.md). Treat this spec as the historical design of record; **the code is the source of truth.**

## 1. Scope

The Foundation slice is **Tier 0**: the smallest thing that proves the reactive-transaction core end-to-end as a single binary over embedded SQLite. It must implement the small end of the [scalability spectrum](../../dev/architecture/scalability-spectrum.md) while **reserving every seam** (in interfaces) that lets the same app code reach the WhatsApp-scale end without an app-code or core-engine rewrite.

**In scope:** monorepo + value/error packages · order-preserving index-key codec · document identity + table registry · SQLite `DocStore` (3-table MVCC) · single-writer 3-phase OCC transactor · query engine (index scans → read-sets, cursor pagination) · V8-isolate UDF executor with a fully-serializable syscall ABI · reactive sync tier (table-level invalidation, subscription manager, protocol, session guardrails, ephemeral-broadcast seam) · embedded runtime (loopback transport, write-fanout) · schema/codegen · `stackbase dev` CLI · client SDK + React `useQuery`.

**Out of scope (deferred — see §11):** range-precise invalidation, Tier 2 distributed sharding/sync fleet, Postgres adapter, ephemeral/presence *implementation* (only the seam ships), auth, files, search/vector execution, multi-runtime hosts, binary wire codec.

## 2. Architecture in one picture

```
  convex/ functions (user TS)        client app (useQuery/useMutation)
         │  bundled+analyzed                      │
         ▼                                        ▼
  ┌───────────────────────── @stackbase/runtime-embedded (ONE process / ONE binary) ──────────────────┐
  │                                                                                                     │
  │   LoopbackWebSocket ⇄ SyncProtocolHandler ──subscribe──▶ SubscriptionManager (table-level)         │
  │        ▲ push (Transition)                    │                    │ readSet                        │
  │        │                                      ▼                    ▼                                │
  │   SyncSession (backpressure/heartbeat)   SyncUdfExecutor ──▶ UdfExec (V8 isolate, string syscalls)  │
  │        ▲ Broadcast (ephemeral seam)           │                    │ syscalls (argJson→json)        │
  │        │                                      ▼                    ▼                                │
  │   EphemeralBroadcast (in-proc)           QueryRuntime ──reads──▶ DocStore (SQLite, MVCC)            │
  │                                               ▲                    ▲                                │
  │   WriteFanout (in-mem) ◀──OplogDelta── SingleWriterTransactor ──writes──┘  (3-phase OCC, 1 shard)  │
  └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Everything in the box is one process at Tier 0. Each `──▶` that crosses a future tier boundary (client↔handler, transactor↔fanout↔sync, executor pool) goes through an **abstract interface with a serializable payload**, so Tier 2 splits the box along those lines with no app-code change.

## 3. Package map & dependency DAG (canonical homes)

The single most important synthesis decision: **each shared type has exactly one canonical home; every other package imports it.** The component designs each re-declared shared types (expected, since they were designed in parallel); this DAG resolves them. Arrows = "depends on".

```
values  errors
  │  ╲     │
  │   ╲    │
index-key-codec ── id-codec(document-identity)
  │        │
  ▼        ▼
docstore (contract) ──▶ docstore-sqlite
  │            │
  ▼            ▼
transactor ◀── query-engine
  │     ╲        │
  ▼      ╲       ▼
executor   sync ◀──────────┐
  │     ╲   │               │
  ▼      ▼  ▼               │
runtime-embedded ───────────┘
  │
  ├─▶ codegen ──▶ cli
  └─▶ client (+ react)
```

| Package | Owns (canonical) | Key exports |
|---|---|---|
| `@stackbase/values` | the Convex-compatible value system | `Value`, `JSONValue`, `GenericId/Id`, `compareValues`, `convexToJson`, `v`, `defineTable/defineSchema`, `ConvexError` |
| `@stackbase/errors` | error hierarchy | `StackbaseError` + subclasses, `toStackbaseError`, `getHttpStatus`, `isRetryableError` |
| `@stackbase/index-key-codec` | **all key/range/cursor types** | `encodeIndexKey`, `compareIndexKeys`, `KeyRange`, `RangeSet`, `SerializedKeyRange`, `serialize/deserializeKeyRange`, `Cursor`/`IndexCursor`, `Keyspace`, `WriteInvalidation` |
| `@stackbase/id-codec` | identity, table registry, shard keys | `InternalDocumentId`, `DocumentId` codec, `TableRegistry`, `ShardId`/`DEFAULT_SHARD`, `ShardKeyResolver`, `ShardRouter` *(declared, Tier 0 = `SimpleShardRouter`)* |
| `@stackbase/docstore` | **the storage contract** | `DocStore`, `DocumentLogEntry`, `LatestDocument`, `ResolvedDocument`, `DatabaseIndexUpdate`, `TimestampOracle`, `Interval`, `TimestampRange`, `Search/VectorCapable` |
| `@stackbase/docstore-sqlite` | SQLite impl | `SqliteDocStore`, `DatabaseAdapter`, `NodeSqliteAdapter`, `SerializedTransactionRunner` |
| `@stackbase/transactor` | OCC + commit | `Transactor`, `SingleWriterTransactor`, `UncommittedWrites`, `CommitResult`, `OplogDelta`, `WriteFanout`, `TransactionContext`, `ConflictError`, headroom |
| `@stackbase/query-engine` | planning + execution | `buildQueryPlan`, `QueryRuntime`, `IndexManager`, `PaginationJournal`, filters; **imports** codec + docstore views |
| `@stackbase/executor` | UDF isolate + **syscall ABI** | `UdfExec`, `UdfExecutionAdapter`, `UdfKernel`, `SyscallRouter`, `SyscallChannel`, `UdfEnvironmentProfile`, `SeededRandom`, `GuestSetup` |
| `@stackbase/sync` | **reactive protocol + tier** | `SyncProtocolHandler`, `SyncSession`, `SubscriptionManager`, `QueryCache`/`CacheStrategy`, `ServerMessage`/`ClientMessage` + codec, backpressure/heartbeat, `EphemeralBroadcast`/`PresenceChannel`, `ChangeStreamConsumer` |
| `@stackbase/runtime-embedded` | Tier 0 composition | `EmbeddedRuntime`, `RuntimeHost`, `LoopbackWebSocket`, `EmbeddedWriteFanout`, `SerializedUdfExecutor`, `HttpHandler` |
| `@stackbase/codegen` | types/api generation | `generateApi/DataModel/Server`, `validatorToTsType`, schema/manifest sources |
| `@stackbase/cli` | `stackbase` CLI | `devCommand`, push pipeline, watch loop, bundler/analyzer, `EmbeddedDeployTarget` |
| `@stackbase/client` (+ `/react`) | reactive client | `StackbaseClient`, `useQuery`, `useMutation`, `useAction`, `usePaginatedQuery`, optimistic updates |

### 3.1 Contested types → canonical resolution (must enforce)

These appeared in multiple component files; the build MUST use the canonical home and delete the duplicates:

| Type | Declared in (designs) | **Canonical home** | Others must |
|---|---|---|---|
| `SerializedKeyRange`, `KeyRange`, `RangeSet`, `compareIndexKeys`, `encodeIndexKey` | codec, query-engine, transactor, sync, runtime | `@stackbase/index-key-codec` | import |
| `WriteInvalidation` | codec, transactor, sync, runtime | `@stackbase/index-key-codec` | import |
| `DocStore`, `DocumentLogEntry`, `LatestDocument`, `ResolvedDocument`, `DatabaseIndexUpdate`, `TimestampOracle` | docstore-sqlite, transactor (`TransactorDocStore`), query-engine (local `DocStore`) | `@stackbase/docstore` | import; transactor/query-engine use **narrowed structural views** that are *subsets* of the canonical `DocStore`, never divergent shapes |
| `ShardId`, `DEFAULT_SHARD` | id-codec, transactor, sync, sqlite | `@stackbase/id-codec` | import |
| `UdfType`, `Visibility` | executor, runtime, codegen, transactor | `@stackbase/values` (or a tiny `@stackbase/protocol-types`) | import |
| `ServerMessage`/`ClientMessage`/`StateVersion`/`StateModification`/`SyncWebSocket`/`SyncUdfExecutor` | sync (canonical), client, runtime | `@stackbase/sync` | client & runtime import the protocol types |
| `EmbeddedWriteFanout*`, `ChangeStreamConsumer` | runtime, sync | `@stackbase/sync` (consumer contract) + `@stackbase/runtime-embedded` (in-mem adapter) | — |
| `UdfExec`, `UdfExecutionAdapter` | executor (canonical), runtime | `@stackbase/executor` | runtime imports |

## 4. The core interfaces, wired

The exact signatures live in the component files; here is the spine that ties them together (all `bigint` timestamps; all cross-tier payloads serializable).

- **Storage** — `DocStore.index_scan(indexId, tableId, readTimestamp, interval, order, limit?) → AsyncGenerator<[IndexKeyBytes, LatestDocument]>`, `write(docs: DocumentLogEntry[], indexes, strategy, shardId?)`, `previous_revisions(...)` (OCC), `load_documents(tsRange)` (fanout source). `DocumentLogEntry = {ts, id, value|null, prev_ts}`.
- **Time** — `TimestampOracle.allocateTimestamp(): bigint` (one per shard; Tier 0 = one).
- **Commit** — `Transactor.runInTransaction(fn, opts) → RunResult<T>`; on success emits `CommitResult{ commitTs, shardId, oplog: OplogDelta }`; `OplogDelta = { commit_ts, written_ranges: SerializedKeyRange[], written_tables, shard_id }` → published to `WriteFanout`.
- **Query** — `QueryRuntime` executes a `QueryPlan` via `DocStore.index_scan`, recording touched intervals into a `RangeSet` (the read-set) that doubles for OCC and invalidation; `paginate` returns `(IndexCursor, QueryJournal)`.
- **Execute** — `UdfExec.execute(opts) → Promise<UdfResult>`; user code reaches the engine **only** through `SyscallRouter`: `SyscallHandler = (ctx: KernelContext, argJson: string) => Promise<string>` — **string in, string out**, so it crosses a V8 isolate boundary unchanged.
- **React** — `SyncProtocolHandler.onMessage(ClientMessage)` and `.notifyWrites(WriteInvalidation)`; `SubscriptionManager` (default `MatchMode="table"`) maps a committed write's tables/ranges → affected `(session, query)` pairs → recompute → `Transition` (version-bracketed) pushed via `SyncSession`.
- **Compose** — `EmbeddedRuntime` wires DocStore+Transactor+QueryRuntime+UdfExec+SyncProtocolHandler and exposes `createTransport()` → a `LoopbackWebSocket` the unmodified client connects to.

## 5. End-to-end data flow

**Read (subscribe):** client `useQuery(api.messages.list, {conversationId})` → `ClientMessage:ModifyQuerySet(add)` over loopback → `SyncProtocolHandler` → `SyncUdfExecutor` runs the query in an isolate at a snapshot `ts`; `QueryRuntime` records the read-set `RangeSet` → `SubscriptionManager.subscribe(session, queryHash, readSet)` → result returned in a `Transition` and cached in `QueryCache` by content-addressed `QueryHash`.

**Write (mutation → reactive push):** client `useMutation(api.messages.send)` → `ClientMessage:Mutation` → executor runs the mutation in an isolate; DB syscalls stage writes into `UncommittedWrites` (read-your-own-writes) → `Transactor` 3-phase OCC commit: validate read-set via `previous_revisions`/`prev_ts` (conflict ⇒ `OccConflictError` ⇒ **replay the deterministic UDF**) → allocate one `commitTs` → atomically apply docs+index updates → emit `OplogDelta` to `WriteFanout` → `ChangeStreamConsumer` calls `SyncProtocolHandler.notifyWrites` → `SubscriptionManager` finds subscriptions whose read-set intersects the write's tables → recompute those queries → push `Transition` (advancing `startVersion→endVersion`) to each affected session except the originator (which already has the authoritative `MutationResponse`).

## 6. Reserved scale-seams (the contract that makes Tier 2 a config change)

Full detail in [scalability-spectrum.md §3/§5](../../dev/architecture/scalability-spectrum.md). The three **non-negotiable** mandate seams and the interfaces that carry them:

1. **Shard key → single-writer-per-shard** (unbounded write scale). `shardId` threads through `DocStore.write`, `Transactor`, `TimestampOracle`, `CommitResult`, `WriteInvalidation` — always `"default"` at Tier 0. A document-field shard key (`conversationId`) is resolvable via `ShardKeyResolver`; `ShardRouter.getShardForDocument` is *declared*, implemented later.
2. **Connection-sharded sync fleet.** `SyncProtocolHandler` talks only to abstract `SyncWebSocket`/`SyncUdfExecutor`; no concrete socket type leaks into reactive logic. Tier 0 = one in-process node + `SimpleShardRouter`; Tier 2 = fleet + rendezvous `getSyncNodeId`.
3. **Ephemeral broadcast bypassing the durable log** (presence/typing/receipts). `ServerMessage` is a **versioned, extensible union with a `Broadcast` kind**; the handler exposes an ephemeral ingress **distinct from `notifyWrites`** (`EphemeralBroadcast`/`PresenceChannel`). Tier 0 = trivial in-process delivery; Tier 2 = fleet pub/sub on a non-durable topic. *The interface ships in Foundation even though the feature does not* — retrofitting it later is a wire break.

Supporting seams also reserved: `WriteFanout`/`ChangeStreamConsumer` with serializable `OplogDelta` (transactor→sync indirection); `bufferedAmount` + backpressure/heartbeat with **version-gap ⇒ full client resync** (so Tier 2 frame-drops are correct); `UdfExec` stateless + `CacheStrategy` (read-scaling); `encodeServerMessage` isolating the wire (binary codec drop-in); `ShardRouter`/`SyncShardMap`/`SyncNodeLoadReport` (declared).

## 7. Tier 0 deployment

One process, one SQLite file (WAL), one volume. `docker run` or a single binary; the dashboard/HTTP served in-process by `HttpHandler`. The unmodified client connects over `LoopbackWebSocket` (in-process) — proving the protocol path without a network. Desktop bundling (Electron/Tauri) is the same artifact.

## 8. Determinism & the serializable syscall ABI

Queries/mutations are deterministic: `UdfEnvironmentProfile` sets `CapabilityMode` per family — `QUERY/MUTATION_PROFILE` give a **seeded** PRNG wired into `Math.random`/`crypto` and **forbid** clock/network/timers; `ACTION_PROFILE` grants `native`. Because the syscall boundary is **`argJson: string → Promise<string>`**, the same ABI works inline (Tier 0) and across a real V8 isolate or a worker/process boundary (read-scaling) with no reshape — this directly avoids concave's `performJsSyscall` non-serializable trap flagged in [internals/05](../../dev/architecture/internals/05-udf-execution.md).

## 9. Testing strategy (high level)

Per-component unit tests, plus the load-bearing property tests: **order-preserving codec** (`encodeIndexKey` round-trip + `compareIndexKeys(a,b) === compareValues(tuple_a, tuple_b)` over generated tuples spanning all types), **id codec** (round-trip + fletcher16 rejects corruption), **OCC** (concurrent conflicting mutations → exactly-one-commits + deterministic replay), **pagination stability** (no skip/dup under concurrent head inserts), and the **§5 end-to-end** reactive push. See the per-component files for the full matrices.

## 10. Inline review (interim — full adversarial pass pending)

Since the workflow's review/red-team phases didn't run, here is the focused check against the known traps:

- ✅ **Serializable syscall ABI** — `SyscallHandler` is string-in/string-out; crosses an isolate. *Resolved in design.*
- ✅ **Three mandate seams present** — shard key (id-codec/transactor), abstract sync transport (sync), ephemeral `Broadcast`/`PresenceChannel` (sync). *Present.*
- ✅ **Table-level invalidation first** — `MatchMode="table"` default, interval tree present but reserved (`"range"`). *Honored.*
- ⚠️ **Duplicate type declarations** — the #1 real risk: `SerializedKeyRange`/`WriteInvalidation`/`DocStore`/`ShardId`/`UdfType`/`ServerMessage` are each declared in 3–6 component files. **§3.1 is the binding resolution**; the build must import canonicals, not redeclare, or the packages won't compose. This is the first thing milestone 0/1 must enforce (a single `types` pass).
- ⚠️ **`DocStore` narrowing** — transactor's `TransactorDocStore` and query-engine's local `DocStore` must be *structural subsets* of the canonical interface, verified by a compile-time `satisfies` check, not parallel definitions.
- ⚠️ **Open: V8 isolate vs inline executor for M5.** The ABI supports both; Tier 0 could ship the inline `SerializedUdfExecutor` first and add true isolates later (both implement `UdfExec`). See §12 open decisions.
- 🔜 **Deferred to the resumed workflow:** independent per-component adversarial review, the 4 scale-stress scenarios, and the 3 red-team dimensions. Their findings will patch this spec (changelog appended on resume).

## 11. Deferred past Foundation

Range-precise invalidation · Tier 2 distributed sharding + sync fleet + coordinator · Postgres `DocStore` adapter · ephemeral/presence *implementation* · auth · file storage · search/vector execution · multi-runtime hosts (Bun/CF) · binary wire codec · infinite-retention compaction policy.

## 12. Open decisions for the human

1. **M5 executor:** ship the **inline executor first** (faster to a working E2E, same `UdfExec` contract) and add real V8 isolates as a follow-up, or build **isolates up front**? *(Recommend inline-first.)*
2. **Package granularity:** keep `index-key-codec`/`id-codec`/`docstore` as separate published packages, or fold them into a single `@stackbase/core` with subpath exports? *(Recommend separate for clean boundaries; revisit before publishing.)*
3. **Runtime baseline:** target **Node 22+** only for Foundation, or Bun-first? *(Recommend Node 22+ for reach; Bun is a later runtime adapter.)*
4. **License:** confirm **MIT** vs **Apache-2.0** for the OSS release (both clean vs concave's FSL).

---

**Next:** the [implementation plan](./2025-05-15-foundation-implementation-plan.md) turns this into an ordered, independently-verifiable milestone sequence.
