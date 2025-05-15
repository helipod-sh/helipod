---
title: Foundation — Reactive Sync Tier (Subscriptions, Protocol, Sessions)
slug: reactive-sync-tier
status: design (implementation-ready)
audience: engineering (internal)
depends_on: [index-key-codec, occ-transactor]
seam_rows: [3, 4, 5, 6]   # scalability-spectrum.md §3
---

# Reactive Sync Tier — Foundation Component Design

> **Clean-room.** This design was written from the Stackbase architecture docs and the
> clean-room internals notes ([internals/03](../internals/03-reactivity-sync.md),
> [02](../internals/02-transactions-consistency.md), [04](../internals/04-query-engine.md),
> [05](../internals/05-udf-execution.md), [06](../internals/06-runtimes-topology.md)). It is our
> own implementation. No concave source is copied; concave names are cited only to anchor
> behavioral parity for reviewers. The shipped code lives in `packages/` under MIT/Apache.

> **One-line responsibility.** The realtime brain: hold subscriptions as content-addressed
> `QueryHash → recorded read set`; match committed write sets to affected subscriptions
> (table-level first, interval-tree range-matching reserved); re-run affected queries and push
> version-bracketed `Transition`s over the `ModifyQuerySet` diff protocol; dedup shared queries via
> a TTL+LRU cache; run session guardrails (heartbeat, backpressure-with-drop, rate-limit, sub-cap);
> deliver ephemeral broadcasts. **Talks ONLY to abstract transport + executor interfaces.**

---

## 1. Purpose & boundaries

### 1.1 What this component OWNS

1. **The sync protocol** — the `ClientMessage` / `ServerMessage` catalog, the `ModifyQuerySet`
   diff applied against a per-session `StateVersion`, version-bracketed `Transition`s, and the
   swappable wire codec (`ServerMessageCodec`; JSON now, binary-delta later).
2. **Subscriptions** — the `SubscriptionManager`: content-addressed query identity
   (`QueryHash`), recorded read sets (`KeyRange[]` + coarse table set), the write→subscription
   matcher (table-level Set match now; `IntervalTree` range match reserved), the OCC-aware
   "subscribe-then-check-for-missed-writes" handshake, and lifecycle (unsubscribe, disconnect,
   reconnect rebinding).
3. **Query dedup cache** — the in-memory `QueryCache` (TTL+LRU, table-indexed invalidation) behind
   the pluggable `CacheStrategy` seam.
4. **Sessions & guardrails** — `SyncSession` plus the four controllers: heartbeat,
   backpressure-with-drop, rate-limit, and per-session subscription cap; per-session lock +
   operation timeout.
5. **The invalidation ingress** — `notifyWrites(WriteInvalidation)` as the *single* entry point
   for "data changed," fed by a `ChangeStreamConsumer` (in-process at Tier 0).
6. **The ephemeral path** — `EphemeralBroadcast` / `PresenceChannel` and the non-commit
   `Broadcast` server-message kind; an ingress **distinct from `notifyWrites`** that bypasses the
   durable log.
7. **The transport seam** — the `SyncWebSocket` interface and the Tier-0 `LoopbackWebSocket`
   adapter. The reactive logic never imports a concrete socket type.

### 1.2 What this component does NOT own (hard boundaries)

| Concern | Owner | We depend on |
|---|---|---|
| Running user code (V8 isolate, syscalls, determinism) | UDF executor ([internals/05](../internals/05-udf-execution.md)) | `SyncUdfExecutor` interface only |
| OCC commit, timestamps, read/write-set capture | `occ-transactor` (peer Foundation component) | `WriteInvalidation`, `CommitResult`, `commitTimestamp` |
| Order-preserving byte keys, ranges, cursors | `index-key-codec` (peer Foundation component) | `KeyRange`, `SerializedKeyRange`, `compareIndexKeys`, `IndexCursor`, `QueryJournal` |
| Storage / `DocStore` / MVCC log | storage layer ([internals/01](../internals/01-storage.md)) | nothing — we never touch storage |
| Concrete sockets (`ws`, Bun WS, Durable Object) | runtime host packages ([internals/06](../internals/06-runtimes-topology.md)) | `SyncWebSocket` adapters injected in |
| Tier-2 sharding/coordinator/autoscaler | later slice | `ShardRouter` etc. **declared, not built** |

**Invariant the boundaries protect:** the sync tier "never inspects user data semantically, only
the read/write *sets*." Reactivity currency is `(readRanges, writtenRanges, commitTimestamp)` —
nothing else. This is what keeps it storage-independent and lets it scale on a *different axis*
(open connections) than storage (data volume).

### 1.3 Dependencies (consumed contracts)

This component is `dependsOn: [index-key-codec, occ-transactor]`. Those are peer Foundation
components designed separately; we consume their types and must not re-implement them. The exact
shapes we rely on are reproduced (not redefined) in §3.3 and §3.6 so this doc is self-contained,
with a cross-component-contract checklist in §13.

---

## 2. Position in the dataflow

```
                       ┌──────────────────────────────────────────────────────────┐
   clients (WS/loopback)│                  REACTIVE SYNC TIER                       │
        ▲   │           │                                                          │
        │   ▼           │  SyncProtocolHandler ── SyncSession[] (guardrails)       │
   ┌────┴───────┐       │        │            └── SessionBackpressure/Heartbeat... │
   │ SyncWebSocket│◄─────┤        ├── SubscriptionManager (QueryHash → read set)    │
   │  (abstract) │  send │        │      └── IntervalTree (range match, reserved)   │
   └────────────┘       │        ├── QueryCache / CacheStrategy (dedup)            │
                        │        ├── EphemeralBroadcast / PresenceChannel  ◄───────┼─ ephemeral ingress
                        │        └── notifyWrites(WriteInvalidation)      ◄────────┼─ invalidation ingress
                        └───────────────▲───────────────────────▲─────────────────┘
                                        │ executeQuery/Mutation   │ onChanges
                                 ┌──────┴───────┐         ┌───────┴────────────┐
                                 │ SyncUdfExecutor│         │ ChangeStreamConsumer│
                                 │  (abstract)   │         │   (abstract)        │
                                 └──────┬───────┘         └───────▲────────────┘
                                        │                         │ WriteInvalidation (serializable)
                          ┌─────────────┴──────────┐    ┌─────────┴───────────────┐
                          │ occ-transactor + executor│──►│ WriteFanout (publish/sub)│
                          │  (commit → CommitResult) │    │ Tier0: in-memory channel │
                          └──────────────────────────┘    └─────────────────────────┘
```

**Two ingresses, deliberately separate:** `notifyWrites` (durable, commit-derived) and
`broadcastEphemeral` (non-durable, presence/typing). Conflating them is the protocol break the
[scalability spectrum](../scalability-spectrum.md) §2.3 warns about.

---

## 3. Core types & contracts

All code is TypeScript. Package: `packages/server`, module root `packages/server/src/sync/`.
Wire values are JSON; `u64`/timestamps travel as decimal **strings** and are `bigint` internally.

### 3.1 Identifiers & primitives

```ts
// src/sync/types.ts
export type ConnectionId = string;   // server-assigned, one per physical socket (provisional)
export type SessionId    = string;   // client-chosen, stable across reconnects (from Connect)
export type ClientId     = string;   // subscription-ownership key; === SessionId once bound
export type QueryId      = number;   // client-local subscription handle, unique within a session
export type QueryHash    = string;   // content address of (udfPath,args,authKey,componentPath)
export type CacheKey     = string;   // string key for the query cache (superset of QueryHash)
export type ShardId      = string;   // partition key; ALWAYS "default" at Tier 0 (seam row 1)
export type RequestId    = string;   // correlates Mutation/Action request↔response
export type QueryJournal = string | null;   // opaque; owned by query engine, passed through

export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [k: string]: JsonValue };

export const PROTOCOL_VERSION = 1;   // bumped only on a breaking wire change
```

### 3.2 `StateVersion` (the reconciliation clock — seam rows 6 & 10)

```ts
// src/sync/protocol/versions.ts
export interface StateVersion {
  querySet: number;   // ++ on each applied ModifyQuerySet
  ts: bigint;         // logical commit timestamp (data freshness)
  identity: number;   // ++ on each applied Authenticate
}

export function makeStateVersion(querySet: number, ts: bigint, identity: number): StateVersion;
export function compareStateVersion(a: StateVersion, b: StateVersion): -1 | 0 | 1;
/** True iff `next` is the immediate successor the client expects after `prev`
 *  (i.e. no gap). A false here is what makes a client resync. */
export function isContiguous(prev: StateVersion, next: StateVersion): boolean;
```

`StateVersion` is the linchpin of seam rows 6 and 10: a `Transition` is bracketed
`startVersion → endVersion`; a client that receives a `Transition` whose `startVersion` is not its
current version has **missed a frame** and must resync. This is what makes backpressure *drops*
safe and what gives a future binary-delta codec stable per-client acknowledgment points.

### 3.3 Byte keys & ranges (consumed from `index-key-codec`)

Reproduced for reference — **defined by the codec component, not here.**

```ts
// from @stackbase/server queryengine (index-key-codec) — DO NOT redefine
export interface KeyRange {
  tableId: string;            // "table:<hex>" | "index:<hex>:<name>" (namespaced keyspace)
  startKey: Uint8Array;       // order-preserving encoded key
  endKey: Uint8Array | null;  // null = +∞ (unbounded); === startKey when isPoint
  isPoint: boolean;
}
export interface SerializedKeyRange {  // wire/cross-process form
  tableId: string;
  startKey: string;           // base64
  endKey: string | null;      // base64 | null
  isPoint: boolean;
}
export function serializeKeyRange(r: KeyRange): SerializedKeyRange;
export function deserializeKeyRange(r: SerializedKeyRange): KeyRange;
export function compareIndexKeys(a: Uint8Array, b: Uint8Array): -1 | 0 | 1;  // byte order = sort order
export function writtenTablesFromRanges(ranges: SerializedKeyRange[]): string[];
```

> **Cross-component contract (confirm with codec, §13):** byte keys are `Uint8Array` (our
> ergonomic choice over `ArrayBuffer`). `endKey === null` means +∞; a point range has
> `endKey === startKey`. The sync tier compares keys **only** via `compareIndexKeys` — it never
> assumes an encoding.

### 3.4 The protocol — `ClientMessage`

```ts
// src/sync/protocol/messages.ts
export type ClientMessage =
  | ConnectMessage
  | ModifyQuerySetMessage
  | MutationRequestMessage
  | ActionRequestMessage
  | AuthenticateMessage
  | EphemeralPublishMessage    // ephemeral ingress from client (typing/presence) — seam row 5
  | ClientEventMessage;        // generic telemetry

export interface ConnectMessage {
  type: "Connect";
  sessionId: SessionId;
  connectionCount: number;            // reconnect diagnostics
  lastCloseReason?: string | null;
  maxObservedTimestamp?: string | null;  // u64 string; how fresh the client already is
}

export interface ModifyQuerySetMessage {
  type: "ModifyQuerySet";
  baseVersion: number;                // querySet version this diff applies to
  newVersion: number;                 // resulting querySet version
  modifications: QuerySetModification[];
}
export type QuerySetModification =
  | { kind: "Add"; queryId: QueryId; udfPath: string; args: JsonValue[];
      journal?: QueryJournal; componentPath?: string }
  | { kind: "Remove"; queryId: QueryId };

export interface MutationRequestMessage {
  type: "Mutation"; requestId: RequestId; udfPath: string; args: JsonValue[]; componentPath?: string;
}
export interface ActionRequestMessage {
  type: "Action"; requestId: RequestId; udfPath: string; args: JsonValue[]; componentPath?: string;
}
export interface AuthenticateMessage {
  type: "Authenticate";
  tokenType: "Admin" | "System" | "User" | "None";
  value?: string;                     // token; absent for None
  baseVersion: number;                // identityVersion this builds on
  impersonating?: string;
}
export interface EphemeralPublishMessage {
  type: "EphemeralPublish";
  topic: string;                      // e.g. "conv:<id>:typing"
  event: JsonValue;                   // opaque app payload
  ttlMs?: number;                     // server clamps to [0, maxEphemeralTtlMs]
}
export interface ClientEventMessage { type: "Event"; name: string; payload?: JsonValue; }
```

### 3.5 The protocol — `ServerMessage` (versioned & extensible — seam row 5)

```ts
// src/sync/protocol/messages.ts
export type ServerMessage =
  | TransitionMessage
  | MutationResponseMessage
  | ActionResponseMessage
  | BroadcastMessage           // ephemeral, NOT derived from a commit — seam row 5
  | AuthErrorMessage
  | FatalErrorMessage
  | PingMessage;
// FORWARD-COMPAT RULE: clients MUST ignore unknown `type` discriminants. New non-commit kinds
// (Broadcast was the first) can be added without a PROTOCOL_VERSION bump.

export interface TransitionMessage {
  type: "Transition";
  startVersion: StateVersion;         // client must currently be at startVersion, else resync
  endVersion: StateVersion;
  modifications: StateModification[];
}
export type StateModification =
  | { kind: "QueryUpdated"; queryId: QueryId; value: JsonValue; logLines: string[];
      journal: QueryJournal; trace?: string }
  | { kind: "QueryFailed"; queryId: QueryId; errorMessage: string; errorData?: JsonValue;
      logLines: string[]; journal: QueryJournal }
  | { kind: "QueryRemoved"; queryId: QueryId };

export interface MutationResponseMessage {
  type: "MutationResponse"; requestId: RequestId; success: boolean;
  result?: JsonValue; errorMessage?: string; errorData?: JsonValue;
  ts?: string;                        // commit timestamp (u64 string) on success-with-writes
  logLines: string[]; trace?: string;
}
export interface ActionResponseMessage {
  type: "ActionResponse"; requestId: RequestId; success: boolean;
  result?: JsonValue; errorMessage?: string; errorData?: JsonValue; logLines: string[];
}
export interface BroadcastMessage {
  type: "Broadcast";
  topic: string;
  events: EphemeralEvent[];           // batched per topic per flush
}
export interface EphemeralEvent { senderId?: ClientId; event: JsonValue; emittedAtMs: number; }

export interface AuthErrorMessage {
  type: "AuthError"; errorMessage: string; baseVersion: number; authUpdateAttempted: boolean;
}
export interface FatalErrorMessage { type: "FatalError"; errorMessage: string; }
export interface PingMessage { type: "Ping"; }
```

### 3.6 The wire codec (swappable — seam row 10)

```ts
// src/sync/protocol/codec.ts
export interface ServerMessageCodec {
  readonly contentType: string;     // "application/json" | "application/x-stackbase-bsatn"
  /** Stamps PROTOCOL_VERSION; output type matches the negotiated transport frame type. */
  encode(msg: ServerMessage): string | Uint8Array;
  decodeClient(data: string | Uint8Array): ClientMessage;   // throws ProtocolError on malformed
}
export class JsonServerMessageCodec implements ServerMessageCodec { /* default; Tier 0 */ }
export function parseClientMessage(data: string | Uint8Array): ClientMessage;  // JSON fast path
export function encodeServerMessage(msg: ServerMessage): string;              // JSON fast path
export class ProtocolError extends Error { constructor(reason: string); }
```

The handler holds a `ServerMessageCodec` and only ever calls `encode` / `decodeClient`. Dropping
in `BsatnServerMessageCodec` (binary deltas, [strategy §locked divergence 2](../strategy.md)) is a
constructor swap — the state model (`StateVersion` brackets) is untouched. **This is seam row 10.**

### 3.7 The transport seam — `SyncWebSocket` (seam rows 3 & 6)

```ts
// src/sync/transport/sync-websocket.ts
export enum WebSocketReadyState { CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3 }

export interface SyncWebSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: WebSocketReadyState;
  /** Bytes queued in the OS/socket buffer not yet flushed. The backpressure signal (row 6).
   *  Loopback returns 0; a real WS returns the kernel send-buffer depth. */
  readonly bufferedAmount?: number;
}

/** Fuller runtime-facing interface the host wires up (Node `ws`, Bun, DO, loopback). */
export interface SyncWebSocketConnection extends SyncWebSocket {
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}
```

`bufferedAmount` is in the interface **from day one** even though Tier-0 loopback always returns 0
— it cannot be retrofitted without a protocol/host break (scalability-spectrum §2.5).

### 3.8 The execution seam — `SyncUdfExecutor` (consumed; seam row 3)

The *only* thing the sync tier needs from execution. The runtime composes the UDF executor +
`occ-transactor` behind this interface.

```ts
// src/sync/executor/sync-udf-executor.ts
export interface SyncUdfExecutor {
  executeQuery(req: SyncQueryRequest): Promise<SyncQueryOutcome>;
  executeMutation(req: SyncMutationRequest): Promise<SyncMutationResult>;
  executeAction(req: SyncActionRequest): Promise<SyncActionResult>;
}

export interface AuthContext {           // consumed from auth/execution layer
  subject: string;                       // principal id (cache-key salt)
  tokenType: "Admin" | "System" | "User" | "None";
  claims?: Record<string, JsonValue>;
}

export interface SyncQueryRequest {
  udfPath: string; args: JsonValue[];
  auth: AuthContext | null; componentPath?: string;
  journal?: QueryJournal;                // replayed for gapless pagination
  snapshotTimestamp?: bigint;            // pin re-runs to the commit ts during a Transition batch
}
export type SyncQueryOutcome = SyncQuerySuccess | SyncQueryFailure;
export interface SyncQuerySuccess {
  ok: true;
  value: JsonValue; logLines: string[];
  readRanges: KeyRange[];                // the reactivity currency
  readTables: string[];                  // coarse table set (table-first invalidation)
  snapshotTimestamp: bigint;
  journal: QueryJournal;
  authIndependent: boolean;              // result never read identity ⇒ shareable across users
  trace?: string;
}
export interface SyncQueryFailure {
  ok: false; errorMessage: string; errorData?: JsonValue;
  logLines: string[]; journal: QueryJournal;
}

export interface SyncMutationRequest {
  udfPath: string; args: JsonValue[];
  auth: AuthContext | null; componentPath?: string; requestId: RequestId;
}
export interface SyncMutationResult {
  success: boolean;
  value?: JsonValue; errorMessage?: string; errorData?: JsonValue;
  logLines: string[]; trace?: string;
  writtenRanges: SerializedKeyRange[];   // serialized — crosses the fan-out boundary verbatim
  writtenTables: string[];
  commitTimestamp?: bigint;              // present iff success and writes occurred
  shardId: ShardId;                      // seam row 1 — "default" at Tier 0
}
export interface SyncActionRequest {
  udfPath: string; args: JsonValue[];
  auth: AuthContext | null; componentPath?: string; requestId: RequestId;
}
export interface SyncActionResult {
  success: boolean;
  value?: JsonValue; errorMessage?: string; errorData?: JsonValue; logLines: string[];
  // actions are non-transactional; no timestamp, no ranges
}
```

OCC retry lives **inside** `executeMutation` (the executor replays the deterministic UDF on
`ConflictError`, [internals/02](../internals/02-transactions-consistency.md)). The sync tier only
relays the final outcome.

### 3.9 The invalidation ingress — `WriteInvalidation`, `ChangeStreamConsumer`, `WriteFanout` (seam row 4)

```ts
// src/sync/invalidation/types.ts  (WriteInvalidation/OplogDelta shapes consumed from occ-transactor)
export interface WriteInvalidation {
  writtenRanges?: SerializedKeyRange[]; // serialized: crosses process boundaries unchanged
  writtenTables?: string[];             // coarse signal for table-level matching
  commitTimestamp?: bigint;
  snapshotTimestamp?: bigint;
  shardId?: ShardId;                    // seam row 1
  originId?: string;                    // fan-out dedup: a node ignores its own originId
}
export function normalizeWriteInvalidation(raw: unknown): WriteInvalidation;
export function hasWriteInvalidation(inv: WriteInvalidation): boolean;

// src/sync/invalidation/change-stream-consumer.ts
export interface ChangeStreamPosition { ts: bigint; shardId?: ShardId; }
export interface ChangeStreamConsumer {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  /** Register the sink. The handler passes `notifyWrites`. Returns an unsubscribe fn. */
  onChanges(listener: (inv: WriteInvalidation) => void): () => void;
  getCurrentPosition(): ChangeStreamPosition;
}
/** Tier 0: tails the in-process write-fanout; calls the listener synchronously after commit. */
export class InProcessChangeStreamConsumer implements ChangeStreamConsumer { /* ... */ }

// src/sync/invalidation/write-fanout.ts  (the publish boundary — scalability-spectrum §2.4)
export interface EmbeddedWriteFanoutPayload {
  originId: string; messageId: string; emittedAtMs: number; invalidation: WriteInvalidation;
}
export interface EmbeddedWriteFanoutAdapter {
  publish(payload: EmbeddedWriteFanoutPayload): void | Promise<void>;
  subscribe(listener: (p: EmbeddedWriteFanoutPayload) => void): () => void;  // returns unsubscribe
  close(): void | Promise<void>;
}
export interface EmbeddedWriteFanout {
  readonly originId: string;
  publish(invalidation: WriteInvalidation): void | Promise<void>;
}
/** Tier 0 default adapter: a synchronous in-memory channel. Swap for BroadcastChannel/Redis/Queues
 *  and the SAME fan-out spans many processes; each ignores its own originId, dedups by messageId. */
export class InMemoryWriteFanoutAdapter implements EmbeddedWriteFanoutAdapter { /* ... */ }
export function createEmbeddedWriteFanout(
  originId: string,
  adapter: EmbeddedWriteFanoutAdapter,
  onRemoteWrite: (inv: WriteInvalidation) => void,
): EmbeddedWriteFanout;
```

**The seam is the indirection itself:** the transactor *publishes*; the sync tier *subscribes*.
They are never directly coupled. At Tier 0 both ends sit in one process over the in-memory adapter;
at Tier 2 the adapter becomes a distributed change stream and the *same* `notifyWrites` runs on
each node. **This is seam row 4.**

---

## 4. Subscription manager

### 4.1 Model

A **subscription** = `(clientId, queryId) → { queryHash, readRanges, readTables, snapshotTimestamp }`.
Many clients issuing the same query (same `QueryHash`) share one logical recompute and fan out to
all of them (dedup, §6).

```ts
// src/sync/subscriptions/subscription-manager.ts
export type MatchMode = "table" | "range";   // "table" is the v1 default; "range" reserved

export interface SubscriptionManagerOptions {
  matchMode?: MatchMode;                 // default "table"
  intervalTreePerTable?: boolean;        // reserved; build one IntervalTree per tableId
  tableWriteTsRetentionMs?: number;      // hygiene; default 5 min
  clock?: () => number;                  // injectable for tests
}

export interface ReadSet { ranges: KeyRange[]; tables: string[]; }
export interface SubscribeResult { needsRerun: boolean; queryHash: QueryHash; refCount: number; }

export interface SubscriptionManager {
  /** Register a freshly-executed query's dependencies. Returns needsRerun=true iff a write to one
   *  of its tables landed at ts > snapshotTimestamp (the subscribe/commit race — §4.3). */
  subscribe(clientId: ClientId, queryId: QueryId, readSet: ReadSet,
            queryHash: QueryHash, snapshotTimestamp: bigint): SubscribeResult;

  /** Re-record dependencies after a reactive re-run (the read set can move under the query). */
  updateReadSet(clientId: ClientId, queryId: QueryId, readSet: ReadSet,
                snapshotTimestamp: bigint): void;

  unsubscribe(clientId: ClientId, queryId: QueryId): void;
  unsubscribeAll(clientId: ClientId): void;                 // on disconnect
  rebindClient(oldClientId: ClientId, newClientId: ClientId): void;  // reconnect rebinding

  /** Close the subscribe/commit race: remember the latest write ts per table. */
  recordWrites(inv: WriteInvalidation): void;

  /** The matcher. Returns the exact (client, query) pairs to re-run. */
  findAffectedQueries(inv: WriteInvalidation): Map<ClientId, Set<QueryId>>;

  getQueryHash(clientId: ClientId, queryId: QueryId): QueryHash | undefined;
  refCount(queryHash: QueryHash): number;

  maybeCleanupTableWriteTimestamps(): void;                 // lazy hygiene
  forceCleanupTableWriteTimestamps(olderThan: bigint): void;

  getStats(): SubscriptionStats;
  assertConsistency(): void;                                // test/observability invariant check
}
export interface SubscriptionStats {
  clients: number; subscriptions: number; uniqueQueryHashes: number;
  trackedTables: number; matchMode: MatchMode;
}
```

### 4.2 Internal indexes

- `byClient: Map<ClientId, Map<QueryId, SubRecord>>` — ownership + lifecycle.
- `byHash: Map<QueryHash, Set<ClientRef>>` where `ClientRef = {clientId, queryId}` — dedup fan-out.
- **Table-level matcher (v1 default):** `byTable: Map<string /*tableId*/, Set<ClientRef>>`. A write
  to table `X` ⇒ every `ClientRef` in `byTable["table:X…"]` is affected. Correctness over
  cleverness: O(writtenTables × affected).
- **Range matcher (reserved):** one `IntervalTree<ClientRef>` per `tableId`. Only consulted when
  `matchMode === "range"`. Must be validated as a strict refinement of the table matcher (§11).
- `tableWriteTimestamps: Map<string /*tableId*/, bigint>` — latest write ts per table, for the
  subscribe race; trimmed by the retention policy.

### 4.3 The subscribe/commit race handshake (correctness-critical)

There is a window between a query reading its snapshot (`snapshotTimestamp`) and its subscription
being registered. A write in that gap would be missed. So:

```
subscribe(clientId, queryId, readSet, queryHash, snapshotTs):
    register the subscription into byClient/byHash/byTable (+ interval trees if range mode)
    needsRerun = false
    for tableId in readSet.tables:
        if tableWriteTimestamps[tableId] > snapshotTs:   # a newer write already happened
            needsRerun = true
    return { needsRerun, queryHash, refCount }
```

The caller (handler) immediately re-runs the query if `needsRerun`, before trusting the result.
**Register first, then check** — registering before the check guarantees no write between check and
register is lost.

### 4.4 `findAffectedQueries` (table-level, v1)

```
findAffectedQueries(inv):
    affected = Map<ClientId, Set<QueryId>>
    tables = inv.writtenTables ?? writtenTablesFromRanges(inv.writtenRanges ?? [])
    if matchMode == "table":
        for tableId in tables:
            for ref in byTable[tableId] ?? ∅:  affected[ref.clientId].add(ref.queryId)
    else: # range mode (reserved) — strict subset, validated against the above
        for range in inv.writtenRanges:
            tree = intervalTrees[range.tableId]
            for ref in tree.findIntersecting(range.startKey, range.endKey, range.isPoint):
                affected[ref.clientId].add(ref.queryId)
    return affected
```

### 4.5 `IntervalTree` (reserved range matcher)

```ts
// src/sync/subscriptions/interval-tree.ts  — built, unit-tested, OFF by default
export interface Interval<T> { start: Uint8Array; end: Uint8Array | null; isPoint: boolean; data: T; }
export interface IntervalTree<T> {
  insert(iv: Interval<T>): void;
  remove(iv: Interval<T>): boolean;
  findIntersecting(start: Uint8Array, end: Uint8Array | null, isPoint: boolean): T[];
  readonly size: number;
}
export class AugmentedBstIntervalTree<T> implements IntervalTree<T> { /* keyed on start, caches subtreeMax end */ }
export function intervalsIntersect(
  aStart: Uint8Array, aEnd: Uint8Array | null,
  bStart: Uint8Array, bEnd: Uint8Array | null): boolean;  // null end = +∞; uses compareIndexKeys
```

Augmented BST keyed on `start`, each node caching `subtreeMax` (max `end`, `null`=+∞). Overlap query
prunes the left subtree when `leftSubtreeMax < queryStart` → O(log n + k). **Two hardening upgrades
over the reference baseline (deferred):** (a) self-balancing (red-black / weight-balanced) so
adversarial insert order can't skew to O(n); (b) per-`tableId` trees so a write probes only its own
keyspace. v1 ships the table-level Set matcher as the correctness baseline and validates the tree
against it differentially (§11) before it is ever enabled.

### 4.6 Query identity & cache keying

```ts
// src/sync/subscriptions/query-hash.ts
export interface QueryIdentityInput {
  udfPath: string; args: JsonValue[]; authKey: string | null; componentPath?: string;
}
export function computeQueryHash(input: QueryIdentityInput): QueryHash;     // stable content hash
export function computeQueryCacheKey(input: QueryIdentityInput): CacheKey;
/** authKey is null when the query is authIndependent (shareable across all principals);
 *  otherwise it is derived from auth.subject so per-principal results never collide. */
export function deriveAuthKey(auth: AuthContext | null, authIndependent: boolean): string | null;
```

Args are canonicalized (stable key order, normalized numbers) before hashing so semantically equal
queries collapse. `authIndependent` is derived **conservatively** (default: auth-dependent) from
`SyncQuerySuccess.authIndependent` — it is the only thing preventing one user's row-secured result
from leaking to another through the shared cache (§11 audit).

---

## 5. Query cache & `CacheStrategy` (dedup — seam row 8)

```ts
// src/sync/cache/query-cache.ts
export interface CachedQuery {
  result: JsonValue; logLines: string[];
  readRanges: KeyRange[]; readTables: string[];
  snapshotTimestamp?: bigint; journal: QueryJournal;
  authIndependent: boolean; cachedAt: number; trace?: string;
}
export interface QueryCacheOptions { maxEntries: number; ttlMs: number; clock?: () => number; }
export interface QueryCache {
  get(key: CacheKey): CachedQuery | undefined;          // undefined if absent or TTL-expired
  set(key: CacheKey, entry: CachedQuery): void;          // LRU-evicts past maxEntries
  invalidateByTables(tables: string[]): void;            // O(affected) via reverse index
  delete(key: CacheKey): void;
  clear(): void;
  readonly size: number;
}
/** Tier 0 in-memory implementation: Map + LRU ring + `tableToKeys` reverse index. */
export class InMemoryQueryCache implements QueryCache { /* ... */ }

// src/sync/cache/cache-strategy.ts  — the pluggable async seam (Tier 2 distributed cache)
export interface CacheKeyParts { queryPath: string; argsHash: string; authKey: string | null; componentPath?: string; }
export interface CachedResult { value: JsonValue; cachedAt: number; dependencies: string[]; journal: QueryJournal; }
export interface CacheStrategy {
  get(key: CacheKeyParts): Promise<CachedResult | undefined>;
  set(key: CacheKeyParts, value: CachedResult): Promise<void>;
  invalidate(tables: string[]): Promise<void>;     // driven off the change stream at Tier 2
  clear(): Promise<void>;
}
export class SimpleCacheStrategy implements CacheStrategy { /* wraps InMemoryQueryCache */ }
```

The `tableToKeys` reverse index means `invalidateByTables` drops exactly the affected entries —
the cache's mirror of the subscription manager's table-level match. At Tier 2 a shared/distributed
`CacheStrategy` (invalidated by change-stream deltas) drops in behind the same seam without touching
the handler.

---

## 6. Sessions & guardrails

### 6.1 `SyncSession`

```ts
// src/sync/session/sync-session.ts
export interface SyncSessionView {
  readonly connectionId: ConnectionId;
  readonly sessionId: SessionId | null;       // null until Connect
  readonly clientId: ClientId | null;
  readonly version: StateVersion;             // {querySet, ts, identity}
  readonly auth: AuthContext | null;
  readonly activeQueryCount: number;
  readonly queueDepth: number;
  readonly queuedBytes: number;
  readonly droppedMessages: number;
}
export interface ActiveQuery {
  queryId: QueryId; udfPath: string; args: JsonValue[];
  journal: QueryJournal; componentPath?: string; queryHash: QueryHash;
}
export class SyncSession implements SyncSessionView {
  constructor(connectionId: ConnectionId, socket: SyncWebSocket,
              codec: ServerMessageCodec, config: SessionGuardrailConfig, clock: () => number);

  /** Serialize all state mutations on one session (prevents version-counter corruption). */
  withSessionLock<T>(fn: () => Promise<T>): Promise<T>;
  withOperationTimeout<T>(fn: () => Promise<T>): Promise<T>;  // bounds client-visible wait only

  /** Every outbound frame goes through backpressure. Returns false if dropped. */
  send(msg: ServerMessage): boolean;

  consumeRateLimit(): boolean;                 // false ⇒ over the rolling window
  projectedActiveQueryCount(delta: number): number;  // for the subscription cap

  bindSession(sessionId: SessionId): void;     // on Connect
  bumpQuerySet(): number; bumpIdentity(): number; advanceTs(ts: bigint): void;

  readonly activeQueries: Map<QueryId, ActiveQuery>;
}

export interface SessionGuardrailConfig {
  pingIntervalMs: number;                      // default 15_000
  backpressureHighWaterMark: number;           // bytes; default 1 MiB
  backpressureBufferLimit: number;             // bytes; default 8 MiB → drop past this
  slowClientTimeoutMs: number;                 // default 30_000
  rateLimitMaxMessagesPerWindow: number;       // default 256
  rateLimitWindowMs: number;                   // default 10_000
  maxActiveQueriesPerSession: number;          // default 1024
  operationTimeoutMs: number;                  // default 15_000
  maxEphemeralTtlMs: number;                   // default 10_000 (clamp EphemeralPublish)
}
```

### 6.2 Controllers (seam row 6)

```ts
// src/sync/session/heartbeat-controller.ts
export interface SessionHeartbeatController { start(): void; clear(): void; }
export interface HeartbeatOptions { pingIntervalMs: number; isOpen: () => boolean; onPing: () => void; onDead: () => void; clock: () => number; }
export function createHeartbeatController(o: HeartbeatOptions): SessionHeartbeatController;

// src/sync/session/backpressure-controller.ts
export interface SessionBackpressureController {
  /** Enqueue/flush one frame. Returns false if the frame was dropped (counted). */
  send(data: string | Uint8Array): boolean;
  readonly queueDepth: number; readonly queuedBytes: number; readonly droppedMessages: number;
}
export interface BackpressureOptions {
  socket: SyncWebSocket;            // reads socket.bufferedAmount
  highWaterMark: number; bufferLimit: number; slowClientTimeoutMs: number; clock: () => number;
}
export function createBackpressureController(o: BackpressureOptions): SessionBackpressureController;

// src/sync/session/rate-limiter.ts
export interface RateLimiter { consume(): boolean; }
export function createRollingWindowRateLimiter(max: number, windowMs: number, clock: () => number): RateLimiter;
```

**Backpressure algorithm.** Each `send`: if `socket.bufferedAmount < highWaterMark`, write through
immediately. Otherwise begin **draining** into a bounded in-memory queue; flush as the socket
drains. If `queuedBytes` would exceed `bufferLimit`, **or** the client has been slow longer than
`slowClientTimeoutMs`, **drop** the frame and increment `droppedMessages`. Dropping is safe because
of version brackets: the next `Transition` the client *does* receive has a `startVersion` ahead of
the client's current version → the client detects the gap and resyncs (§9). A slow client degrades
to a resync, never to silent divergence. At Tier 0 over loopback `bufferedAmount` is 0, so this is a
pass-through no-op — **but the same code path runs**, so Tier 2 needs no new wiring.

---

## 7. `SyncProtocolHandler` (the brain)

```ts
// src/sync/handler/sync-protocol-handler.ts
export interface SyncProtocolHandlerOptions {
  executor: SyncUdfExecutor;
  subscriptions: SubscriptionManager;
  cache?: QueryCache;
  codec?: ServerMessageCodec;                  // default JsonServerMessageCodec
  ephemeral?: EphemeralBroadcast;              // default InProcessEphemeralBroadcast
  changeStream?: ChangeStreamConsumer;         // wired to notifyWrites in start()
  shardRouter?: ShardRouter;                   // default SimpleShardRouter (Tier 0)
  session?: Partial<SessionGuardrailConfig>;
  coalesceWindowMs?: number;                   // batch near-simultaneous commits; default 0 (off)
  clock?: () => number;                        // injectable
}

export interface SyncProtocolHandler {
  start(): Promise<void>;                      // subscribes to the change stream
  stop(): Promise<void>;

  // ---- per-socket lifecycle (host wires these to the concrete socket) ----
  createSession(socket: SyncWebSocket): ConnectionId;
  handleMessage(connectionId: ConnectionId, data: string | Uint8Array): Promise<void>;
  handleClose(connectionId: ConnectionId, code: number, reason: string): void;
  handleError(connectionId: ConnectionId, err: Error): void;

  // ---- INVALIDATION ingress (seam row 4): the single "data changed" entry point ----
  notifyWrites(inv: WriteInvalidation): Promise<void>;

  // ---- EPHEMERAL ingress (seam row 5): DISTINCT from notifyWrites; bypasses the log ----
  broadcastEphemeral(topic: string, event: JsonValue,
                     opts?: { senderId?: ClientId; ttlMs?: number }): void;

  // ---- observability ----
  getBackpressureStats(): BackpressureStats;
  getStats(): HandlerStats;
}
export interface BackpressureStats {
  sessions: number; totalQueuedMessages: number; totalQueuedBytes: number;
  totalDroppedMessages: number; sessionsWithBackpressure: number;
}
export interface HandlerStats { sessions: number; boundSessions: number; subscriptions: SubscriptionStats; cacheSize: number; }
```

### 7.1 Message dispatch (`handleMessage`)

```
handleMessage(connId, data):
    session = sessions[connId]; if !session: drop
    if !session.consumeRateLimit(): send FatalError("rate limit"); close(1008); return
    msg = codec.decodeClient(data)            # ProtocolError ⇒ FatalError + close(1003)
    await session.withSessionLock(() => session.withOperationTimeout(() =>
        switch msg.type:
            Connect          → handleConnect(session, msg)
            ModifyQuerySet   → handleModifyQuerySet(session, msg)
            Mutation         → handleMutation(session, msg)
            Action           → handleAction(session, msg)
            Authenticate     → handleAuthenticate(session, msg)
            EphemeralPublish → handleEphemeralPublish(session, msg)
            Event            → recordTelemetry(msg)
            default          → ignore        # forward-compat
    ))
```

The per-session lock serializes operations so interleaved mutation/query handling can never corrupt
the `StateVersion` counters; the operation timeout bounds only the *client-visible* wait, it does
not cancel underlying work.

### 7.2 `handleConnect` & reconnect rebinding

```
handleConnect(session, {sessionId}):
    if session.sessionId == null:
        session.bindSession(sessionId)
    else if session.sessionId != sessionId:
        subscriptions.rebindClient(session.clientId, sessionId)   # move provisional subs
        session.bindSession(sessionId)
    # client will (re)send its full ModifyQuerySet from baseVersion 0 on a fresh session
```

### 7.3 `handleModifyQuerySet` (the diff protocol)

```
handleModifyQuerySet(session, {baseVersion, newVersion, modifications}):
    if baseVersion != session.version.querySet:        # gap/out-of-order
        send FatalError("querySet version mismatch"); close(1002); return   # client resyncs
    cap = config.maxActiveQueriesPerSession
    mods: StateModification[] = []
    for m in modifications:
        if m.kind == "Remove":
            subscriptions.unsubscribe(session.clientId, m.queryId)
            session.activeQueries.delete(m.queryId)
            mods.push(QueryRemoved{m.queryId})
        else: # Add
            if session.projectedActiveQueryCount(+1) > cap:
                mods.push(QueryFailed{m.queryId, "subscription cap exceeded"}); continue
            mod = await addAndRunQuery(session, m)     # §7.4
            mods.push(mod)
    session.bumpQuerySet()                              # → newVersion
    sendTransition(session, mods)                       # one Transition for the whole diff
```

The client never resends its whole subscription list — only the delta. `baseVersion → newVersion`
makes the diff idempotent and gap-detectable. A cap-exceeding `Add` becomes a `QueryFailed` for that
`queryId` (the version still advances, so the client stays in sync).

### 7.4 `addAndRunQuery` (subscribe + dedup + race handshake)

```
addAndRunQuery(session, add) -> StateModification:
    authKey   = deriveAuthKey(session.auth, /*assume*/ false)
    cacheKey  = computeQueryCacheKey({add.udfPath, add.args, authKey, add.componentPath})
    queryHash = computeQueryHash({...})
    cached = cache?.get(cacheKey)
    if cached:                                          # DEDUP: reuse a peer's result
        sub = subscriptions.subscribe(clientId, add.queryId,
                 {ranges: cached.readRanges, tables: cached.readTables}, queryHash, cached.snapshotTimestamp)
        if !sub.needsRerun:
            session.activeQueries.set(add.queryId, {...add, queryHash})
            return QueryUpdated{add.queryId, cached.result, cached.logLines, cached.journal}
        # else fall through to a fresh run
    outcome = await executor.executeQuery({udfPath, args, auth, componentPath, journal: add.journal})
    if !outcome.ok:
        return QueryFailed{add.queryId, outcome.errorMessage, outcome.errorData, outcome.logLines, outcome.journal}
    authKey  = deriveAuthKey(session.auth, outcome.authIndependent)   # recompute now we know
    cacheKey = computeQueryCacheKey({add.udfPath, add.args, authKey, add.componentPath})
    cache?.set(cacheKey, {result: outcome.value, logLines, readRanges, readTables,
                          snapshotTimestamp, journal, authIndependent, cachedAt: now()})
    sub = subscriptions.subscribe(clientId, add.queryId,
             {ranges: outcome.readRanges, tables: outcome.readTables}, queryHash, outcome.snapshotTimestamp)
    if sub.needsRerun:  return await addAndRunQuery(session, add)     # race lost ⇒ retry (bounded)
    session.activeQueries.set(add.queryId, {...add, queryHash})
    return QueryUpdated{add.queryId, outcome.value, outcome.logLines, outcome.journal, outcome.trace}
```

### 7.5 `handleMutation`

```
handleMutation(session, {requestId, udfPath, args, componentPath}):
    res = await executor.executeMutation({udfPath, args, auth: session.auth, componentPath, requestId})
    session.send(MutationResponse{requestId, res.success, res.value|err, ts: res.commitTimestamp, res.logLines})
    if res.success and res.commitTimestamp != null and res.writtenTables non-empty:
        inv = {writtenRanges: res.writtenRanges, writtenTables: res.writtenTables,
               commitTimestamp: res.commitTimestamp, shardId: res.shardId, originId: fanout.originId}
        await fanout.publish(inv)            # tells OTHER nodes/processes (seam row 4)
        await notifyWrites(inv)              # tell THIS node now (originator included by default)
```

The mutation **response** never flows through `notifyWrites`; only the invalidation does. The
originating session is **included** in the resulting `Transition` by default (it gets its updated
subscriptions). `notifyWrites` accepts an optional `{excludeClientId}` (see §7.6) used only as an
opt-in flicker optimization for clients doing optimistic updates (which already applied the
predicted state from the `MutationResponse`).

### 7.6 `notifyWrites` → `Transition` (the core reactive loop)

```
notifyWrites(inv, opts?):
    if inv.originId == fanout.originId and inv came from the change stream: skip   # ignore self
    subscriptions.recordWrites(inv)                          # close the subscribe race
    cache?.invalidateByTables(tablesOf(inv))                 # drop stale shared results
    affected = subscriptions.findAffectedQueries(inv)        # Map<ClientId, Set<QueryId>>
    for (clientId, queryIds) in affected:
        if opts?.excludeClientId == clientId: continue
        session = sessionByClient[clientId]; if !session: continue
        await session.withSessionLock(async () => {
            mods = []
            for queryId in queryIds:
                aq = session.activeQueries[queryId]; if !aq: continue
                mods.push(await executeReactiveQuery(session, aq, inv.commitTimestamp))
            if mods.length: sendTransition(session, mods, inv.commitTimestamp)
        })
```

```
sendTransition(session, mods, commitTs?):
    start = session.version                                  # {querySet, ts, identity}
    if commitTs != null: session.advanceTs(commitTs)
    end   = session.version
    session.send(Transition{startVersion: start, endVersion: end, modifications: mods})
```

`executeReactiveQuery` is the **atomic unit of reactive re-execution**:

```
executeReactiveQuery(session, activeQuery, snapshotTs?) -> StateModification:
    outcome = await executor.executeQuery({udfPath, args, auth: session.auth,
                  componentPath, journal: activeQuery.journal, snapshotTimestamp: snapshotTs})
    if !outcome.ok:
        return QueryFailed{queryId, outcome.errorMessage, outcome.errorData, outcome.logLines, outcome.journal}
    subscriptions.updateReadSet(clientId, queryId,
        {ranges: outcome.readRanges, tables: outcome.readTables}, outcome.snapshotTimestamp)  # read set may move
    activeQuery.journal = outcome.journal                    # pin pagination end cursor (gapless)
    cache?.set(cacheKeyFor(activeQuery, session.auth, outcome.authIndependent), {result: outcome.value, ...})
    return QueryUpdated{queryId, outcome.value, outcome.logLines, outcome.journal, outcome.trace}
```

**Coalescing (optional, `coalesceWindowMs > 0`):** invalidations arriving within the window are
buffered per session; each affected query is re-run **once** at the newest `commitTimestamp` and
emitted in **one** `Transition`. This cuts redundant re-runs under fan-out bursts. Default off
(immediate) at Tier 0.

### 7.7 `handleAuthenticate`

```
handleAuthenticate(session, {tokenType, value, baseVersion}):
    if baseVersion != session.version.identity: send AuthError("identity version mismatch"); return
    auth = await verifyToken(tokenType, value)        # via injected auth provider; null/throw ⇒ AuthError
    session.auth = auth; session.bumpIdentity()
    # auth change can alter authKey ⇒ active queries are re-keyed lazily on next re-run
```

---

## 8. Ephemeral broadcast & presence (seam row 5)

The non-durable path. Presence/typing/live-"seen" are **not documents**: they never become
`DocumentLogEntry` rows, never touch OCC, never hit the commit log, never serialize through a
shard's single writer. They share the client's socket, session, and backpressure machinery but ride
the distinct `Broadcast` server-message kind.

```ts
// src/sync/ephemeral/ephemeral-broadcast.ts
export interface EphemeralBroadcast {
  publish(topic: string, event: EphemeralEvent): void;
  /** Deliver subsequent events on `topic` to this client. Returns unsubscribe. */
  subscribe(topic: string, clientId: ClientId, deliver: (ev: EphemeralEvent) => void): () => void;
  unsubscribeAll(clientId: ClientId): void;                  // on disconnect
}
/** Tier 0: in-process delivery to locally-subscribed sessions, last-writer-wins, TTL'd in memory. */
export class InProcessEphemeralBroadcast implements EphemeralBroadcast {
  constructor(adapter?: EphemeralBroadcastAdapter, clock?: () => number);
}
/** Same publish/subscribe indirection as WriteFanout. Tier 0 = in-memory; Tier 2 = fleet pub/sub. */
export interface EphemeralBroadcastAdapter {
  publish(topic: string, payload: EphemeralBroadcastPayload): void | Promise<void>;
  subscribe(listener: (topic: string, p: EphemeralBroadcastPayload) => void): () => void;
  close(): void | Promise<void>;
}
export interface EphemeralBroadcastPayload { originId: string; topic: string; event: EphemeralEvent; }

// src/sync/ephemeral/presence-channel.ts  — built on EphemeralBroadcast
export interface PresenceEntry { clientId: ClientId; state: JsonValue; lastSeenMs: number; expiresAtMs: number; }
export interface PresenceChannel {
  join(topic: string, clientId: ClientId, state: JsonValue): void;
  leave(topic: string, clientId: ClientId): void;
  heartbeat(topic: string, clientId: ClientId, state?: JsonValue): void;  // refresh TTL
  snapshot(topic: string): PresenceEntry[];                               // current online set
}
```

Handler wiring:

```
handleEphemeralPublish(session, {topic, event, ttlMs}):
    ttl = clamp(ttlMs ?? config.maxEphemeralTtlMs, 0, config.maxEphemeralTtlMs)
    ephemeral.publish(topic, {senderId: session.clientId, event, emittedAtMs: now()})  # TTL via topic store

broadcastEphemeral(topic, event, opts):                    # server-originated (e.g. presence sweep)
    ephemeral.publish(topic, {senderId: opts?.senderId, event, emittedAtMs: now()})
```

Delivery: `EphemeralBroadcast.subscribe`'s `deliver` callback pushes a `BroadcastMessage{topic,
events}` through `session.send` — the **same backpressure path** as `Transition`s, so a flood of
typing events is subject to the same drop policy and can never exhaust node memory. Because read
receipts split (scalability-spectrum §2.3): the durable `lastReadMessageId` watermark is an ordinary
coarsened mutation (one row per conv/user, flows through `notifyWrites`); the live "seen just now"
pulse is ephemeral (flows through `broadcastEphemeral`). **This is seam row 5.**

---

## 9. Client contract (what the client SDK must honor)

The sync tier's correctness at scale depends on three client behaviors that **cannot be bolted on
later**, so they are specified now:

1. **Any version gap ⇒ full resync.** If a `Transition.startVersion` ≠ the client's current
   `StateVersion`, or a `FatalError`/socket reconnect occurs, the client discards local query state
   and re-issues its entire query set via `ModifyQuerySet` from `baseVersion 0` on a fresh session.
   This is what makes server-side message *drops* (§6.2) correct.
2. **Journal round-trip.** The client stores each `QueryUpdated.journal` and replays it in the
   corresponding `Add`, so reactive pagination stays gapless.
3. **Optimistic reconciliation (optional).** Using `requestId` + the `MutationResponse.ts` + the
   following `Transition`, the client may show predicted state immediately and roll the optimistic
   layer forward/back to server truth. The server stays authoritative.

---

## 10. Tier-2 topology (RESERVED — declared, not built — seam rows 3 & 9)

These types are **declared** so the Tier-0 `SimpleShardRouter` is one implementation of a known
interface. No coordinator/autoscaler is built in Foundation.

```ts
// src/sync/topology/shard-router.ts
export interface InternalDocumentId { table: string; internalId: Uint8Array; }
export interface ShardRouter<TStub = unknown> {
  readonly mode: "simple" | "distributed";
  getShardForDocument(docId: InternalDocumentId): ShardId;      // consistent hashing (Tier 2)
  getCommitterStub(shardId: ShardId): TStub;
  getSyncNodeId(clientId: ClientId): string;                    // rendezvous (sticky) hashing
  getSyncNodeStub(syncNodeId: string): TStub;
}
/** Tier 0: one shard "default", one local sync node. */
export class SimpleShardRouter implements ShardRouter { /* always "default" / local */ }

export interface SyncNodeLoadReport {
  shard: ShardId; region: string; activeSessions: number; reportedAtMs: number;
  messageRatePerSecond?: number; notifyRatePerSecond?: number;
  cpuUtilization?: number; memoryUtilization?: number;
}
export interface SyncShardMap {
  regions: Record<string, string[]>; notifyShards: string[];
  generatedAtMs: number; ttlMs: number; source: "coordinator" | "kv" | "static";
}
export interface SyncTopologyConfig {
  syncNodes: string[]; syncNodesByRegion?: Record<string, string[]>; defaultRegion: string;
  shardMapCacheMs: number; nodeStaleMs: number;
  minShardsPerRegion: number; maxShardsPerRegion: number;
  targetSessionsPerShard: number; allowScaleToZero: boolean;
}
```

`getSyncNodeId(clientId)` is what keeps a client's whole subscription set on one node at Tier 2
(scalability-spectrum §2.2). At Tier 0 it always returns the single local node.

---

## 11. Package / module / file layout

```
packages/server/src/sync/
├── index.ts                          # barrel: public exports
├── types.ts                          # ConnectionId, SessionId, ClientId, QueryId, QueryHash, JsonValue, PROTOCOL_VERSION
├── protocol/
│   ├── messages.ts                   # ClientMessage / ServerMessage unions + sub-types
│   ├── versions.ts                   # StateVersion, makeStateVersion, compareStateVersion, isContiguous
│   └── codec.ts                      # ServerMessageCodec, JsonServerMessageCodec, parse/encode, ProtocolError
├── transport/
│   ├── sync-websocket.ts             # SyncWebSocket, SyncWebSocketConnection, WebSocketReadyState
│   └── loopback-websocket.ts         # LoopbackWebSocket + createLoopbackWebSocketConstructor (Tier 0)
├── executor/
│   └── sync-udf-executor.ts          # SyncUdfExecutor + request/result types, AuthContext
├── invalidation/
│   ├── types.ts                      # WriteInvalidation, normalize/has helpers
│   ├── change-stream-consumer.ts     # ChangeStreamConsumer + InProcessChangeStreamConsumer
│   └── write-fanout.ts               # EmbeddedWriteFanout(+Adapter) + InMemoryWriteFanoutAdapter
├── subscriptions/
│   ├── subscription-manager.ts       # SubscriptionManager (table-level matcher + indexes)
│   ├── interval-tree.ts              # AugmentedBstIntervalTree (reserved range matcher)
│   └── query-hash.ts                 # computeQueryHash, computeQueryCacheKey, deriveAuthKey
├── cache/
│   ├── query-cache.ts                # InMemoryQueryCache (TTL+LRU, tableToKeys reverse index)
│   └── cache-strategy.ts             # CacheStrategy seam + SimpleCacheStrategy
├── session/
│   ├── sync-session.ts               # SyncSession, SessionGuardrailConfig
│   ├── heartbeat-controller.ts       # SessionHeartbeatController
│   ├── backpressure-controller.ts    # SessionBackpressureController (drain + drop)
│   └── rate-limiter.ts               # rolling-window RateLimiter
├── ephemeral/
│   ├── ephemeral-broadcast.ts        # EphemeralBroadcast(+Adapter) + InProcessEphemeralBroadcast
│   └── presence-channel.ts           # PresenceChannel
├── topology/
│   └── shard-router.ts               # ShardRouter, SimpleShardRouter, SyncShardMap, load report (Tier 2 reserved)
└── handler/
    ├── sync-protocol-handler.ts      # SyncProtocolHandler (the brain) + options/stats
    └── query-execution.ts            # executeReactiveQuery (atomic reactive re-run unit)
```

Engine logic in `subscriptions/`, `cache/`, `session/`, `handler/` imports **only** the abstract
`transport/` and `executor/` interfaces — never a concrete socket or the transactor. Lint rule
(enforced): no import of `ws`, `node:*`, Bun, or Cloudflare types under `src/sync/handler/`,
`src/sync/subscriptions/`, `src/sync/session/`.

---

## 12. How it works at Tier 0 (single binary, NOW)

One `EmbeddedRuntime` composes everything in-process (no network, no sidecar):

```
EmbeddedRuntime(options):
    docstore        = SqliteDocStore(...)                      # storage layer (other component)
    executor        = InlineUdfExecutor(services)              # UDF executor (other component)
    transactor      = OccTransactor(docstore, oracle)          # occ-transactor dependency
    fanoutAdapter   = new InMemoryWriteFanoutAdapter()
    fanout          = createEmbeddedWriteFanout("local", fanoutAdapter, inv => handler.notifyWrites(inv))
    changeStream    = new InProcessChangeStreamConsumer(fanoutAdapter)
    syncExecutor    = composeSyncUdfExecutor(executor, transactor, fanout)   # adapts to SyncUdfExecutor
    handler         = new SyncProtocolHandler({
                          executor: syncExecutor,
                          subscriptions: new SubscriptionManager({matchMode:"table"}),
                          cache: new InMemoryQueryCache({maxEntries: 10_000, ttlMs: 60_000}),
                          ephemeral: new InProcessEphemeralBroadcast(),
                          changeStream, shardRouter: new SimpleShardRouter(),
                      })
    await handler.start()                                       # changeStream.onChanges → notifyWrites
```

The client (unmodified) is handed a `LoopbackWebSocket` via `createTransport()`: the "network" is a
function call. `composeSyncUdfExecutor.executeMutation` runs the UDF inside an OCC transaction via
the transactor; on a successful commit it returns `{writtenRanges, writtenTables, commitTimestamp,
shardId:"default"}` and the handler publishes a `WriteInvalidation` to the in-memory fanout, whose
`InProcessChangeStreamConsumer` calls `handler.notifyWrites` synchronously. Subscriptions live in the
in-memory `SubscriptionManager` (table-level Set match); the `QueryCache` dedups shared queries.
Guardrail controllers are wired but no-op (loopback `bufferedAmount === 0`). One shard `"default"`,
`SimpleShardRouter`. This is the smallest thing that proves the reactive core end-to-end.

---

## 13. How the four reserved seams attach later with NO app/engine rewrite

The component spec says *"Four reserved seams converge here."* Each is **present but trivial** at
Tier 0; promotion to Endpoint B (WhatsApp-scale) is adapters + config, never an app-code or
core-engine rewrite. The `convex/` functions and `useQuery` are byte-for-byte identical at both ends.

| Seam (spec row) | Tier 0 (now) | Tier 2 (drop-in) | What makes it a no-rewrite |
|---|---|---|---|
| **Row 3 — connection-sharded fleet.** `SyncWebSocket`/`SyncUdfExecutor` let the SAME handler run as a fleet node, clients sticky-hashed via `ShardRouter.getSyncNodeId`. | One in-process node; `LoopbackWebSocket`; `SimpleShardRouter`. | The identical `SyncProtocolHandler` runs behind a real `ws`/Bun/DO `SyncWebSocket`; `ShardRouter` flips `"simple"→"distributed"` (rendezvous hashing). | The handler imports **no concrete socket and no executor impl** — only the two interfaces. A new host is a new adapter, not a fork. |
| **Row 4 — invalidation ingress.** `ChangeStreamConsumer → notifyWrites` is the single invalidation entry, fed in-process at Tier 0 and by a distributed change-stream at Tier 2. | `InProcessChangeStreamConsumer` over `InMemoryWriteFanoutAdapter`; synchronous post-commit. | Swap the adapter for BroadcastChannel/Redis/Queues/oplog-tail; every node tails the stream and calls its *local* `notifyWrites`. | The transactor **publishes**, the sync tier **subscribes** — never directly coupled. Payload is `SerializedKeyRange` (serializable) + `originId` dedup from day one. |
| **Row 5 — ephemeral broadcast.** `EphemeralBroadcast` + the extensible `ServerMessage` `Broadcast` kind carry presence/typing/read-receipts on a path that BYPASSES the durable log. | `InProcessEphemeralBroadcast`; in-process delivery to local subscribers; ingress = `broadcastEphemeral`, distinct from `notifyWrites`. | Swap the `EphemeralBroadcastAdapter` for fleet pub/sub on a non-durable topic. | `ServerMessage` is versioned and forward-compatible (unknown `type` ignored), and the ephemeral ingress was **never** fused into `notifyWrites`. Retrofitting either would be a wire break — so both exist now. |
| **Row 6 — slow consumers.** `SyncWebSocket.bufferedAmount` + `SessionBackpressureController` + version-gap resync absorb slow consumers at fan-out scale. | Controllers wired into every `SyncSession`; no-op on loopback (`bufferedAmount` 0). | Same code path; on a real socket it drains→drops, and the client resyncs on the version gap. | `bufferedAmount` is in the interface and the controllers run the same path now; the **client's "any version gap ⇒ full resync"** behavior (§9) is specified in Foundation precisely because it can't be added later. |

Supporting seams also reserved here: **row 1** (`shardId` threads through every `WriteInvalidation`/
mutation result, always `"default"`), **row 8** (`SyncUdfExecutor` stateless + pluggable
`CacheStrategy` + content-addressed `QueryHash`), **row 9** (`ShardRouter`/`SyncShardMap`/
`SyncNodeLoadReport` declared), **row 10** (`ServerMessageCodec` isolates the wire so a binary-delta
codec drops in against the existing `StateVersion` ack brackets).

---

## 14. Failure & edge handling

| Situation | Handling |
|---|---|
| **Malformed client frame** | `codec.decodeClient` throws `ProtocolError` → send `FatalError` → `close(1003)`. |
| **`ModifyQuerySet.baseVersion` mismatch** | Reject the whole diff → `FatalError("querySet version mismatch")` → `close(1002)`; client resyncs from `baseVersion 0`. |
| **Subscribe/commit race** | `subscribe` returns `needsRerun: true` (a write landed at ts > snapshot) → handler re-runs before trusting the result (bounded retries; then `QueryFailed`). |
| **Subscription cap exceeded** | The offending `Add` → `QueryFailed{queryId,"subscription cap exceeded"}`; version still advances so the client stays in sync. |
| **Reactive re-run throws** | `executeReactiveQuery` returns `QueryFailed`; the subscription **stays alive** (a transient failure shouldn't drop the live query); next matching write re-runs it. |
| **Mutation OCC conflict** | The executor exhausts bounded retries → `SyncMutationResult.success=false`; handler relays `MutationResponse` error; **no `Transition`** (nothing committed). |
| **Slow consumer / buffer overflow** | Backpressure drains then **drops** frames (counted); the client misses a `Transition`, detects the version gap, and full-resyncs. Never silent divergence. |
| **Dead socket** | Heartbeat `Ping` every 15 s; if `readyState ≠ OPEN` on a tick, `onDead` → `handleClose` → `unsubscribeAll` + `ephemeral.unsubscribeAll`. |
| **Rate-limit exceeded** | Drop message → `FatalError("rate limit")` → `close(1008)`. |
| **Disconnect** | `handleClose` → `subscriptions.unsubscribeAll(clientId)`, `ephemeral.unsubscribeAll(clientId)`, presence `leave`, clear heartbeat, drop the session. |
| **Reconnect rebinding race** | `Connect` rebind runs under the session lock; in-flight messages on the provisional id are serialized behind the rebind so subscriptions aren't lost. |
| **Duplicate / self fan-out (multi-process)** | Ignore payloads whose `originId` is ours; dedup by `messageId`. |
| **Change-stream discontinuity** | On consumer restart/gap (`getCurrentPosition` can't resume), re-run **all** active subscriptions on the node (a bounded resync storm) rather than risk a missed invalidation. |
| **Auth token invalid/expired** | `handleAuthenticate` → `AuthError{authUpdateAttempted:true}`; session keeps its prior identity. |
| **`authIndependent` misjudged** | Default **conservative** (auth-dependent): a result is only shared across principals when the executor proves it never read identity. Audited (§15). |
| **Ephemeral flood** | TTL-clamped, last-writer-wins, delivered through the same backpressure path → droppable; never persisted, never touches OCC. |

---

## 15. Test strategy

### 15.1 Unit tests
- **Protocol codec round-trip.** `parseClientMessage(encode(x)) ≡ x` for every `ClientMessage`/
  `ServerMessage` variant, including `bigint`↔u64-string and forward-compat (unknown `type` ignored).
- **`ModifyQuerySet` gating.** `baseVersion` mismatch rejects; matching `baseVersion` applies; cap
  overflow → `QueryFailed` + version still advances; Add/Remove lifecycle.
- **Subscribe race handshake.** Inject a `recordWrites` at `ts > snapshot` *before* `subscribe` →
  asserts `needsRerun: true`; at `ts ≤ snapshot` → `false`.
- **Table-level matcher.** `findAffectedQueries` returns exactly the clients/queries that read a
  written table; unrelated subscriptions untouched.
- **Query dedup.** N clients, same `QueryHash` → `executor.executeQuery` called **once** per
  invalidation (spy); all N receive the `QueryUpdated`.
- **Cache.** TTL expiry, LRU eviction at `maxEntries`, `invalidateByTables` drops exactly the
  table-dependent keys (reverse-index correctness).
- **Backpressure.** With a fake socket whose `bufferedAmount` is scripted: frames drain below HWM,
  queue bounded by `bufferLimit`, drops counted, `slowClientTimeoutMs` triggers drop.
- **Heartbeat / rate-limit / op-timeout.** Timers fire under a fake clock; dead socket reaped;
  over-window messages rejected; operation timeout bounds visible wait.
- **Ephemeral isolation.** `EphemeralPublish` delivers a `Broadcast` to topic subscribers and makes
  **zero** `executeMutation`/`notifyWrites`/DocStore calls (assert via spies) — proves the log bypass.

### 15.2 Property / differential tests (where correctness is subtle)
- **Interval-tree ⇔ table-matcher differential (the critical one).** Generate random subscription
  read sets and random write sets; assert `range-matches ≡ brute-force-overlap` **and**
  `range-matches ⊆ table-matches`. A range match that **under-reports** vs the table baseline is a
  silent correctness bug → the test must fail. Gate enabling `matchMode:"range"` on this passing.
- **Interval-tree invariants.** After random insert/remove sequences: every node's cached
  `subtreeMax` equals the true subtree max; `findIntersecting` ≡ linear-scan `intervalsIntersect`;
  `size` accurate. (Include adversarial sorted-insert sequences to characterize skew before
  self-balancing lands.)
- **Version monotonicity / gaplessness.** Under arbitrary interleavings of mutations and
  transitions, each session's `StateVersion.ts` is non-decreasing and every delivered `Transition`'s
  `startVersion` equals the previously delivered `endVersion` — **or** a gap is present and the
  modeled client triggers a resync. No third outcome.
- **Backpressure safety (no silent divergence).** Random slow-consumer drop schedules: a modeled
  client that applies only the frames it received either ends `≡` the full-snapshot state **or** has
  observed a version gap and resynced. Assert `queuedBytes ≤ bufferLimit` always.
- **OCC conflict relay.** Property over random mutation/commit/conflict outcomes from a stub
  executor: a conflict → `MutationResponse.success=false` and **zero** `Transition`s; a success with
  writes → exactly one invalidation and one `Transition` per affected session.
- **Query-hash canonicalization.** `computeQueryHash` is invariant under arg key-reordering and
  number normalization, and distinct under any semantic difference (incl. `authKey`).

### 15.3 Integration (loopback, end-to-end)
- Subscribe → mutate → receive a `Transition` with the new value, over `LoopbackWebSocket`.
- Reconnect with the same `sessionId` rebinds subscriptions; queries resume.
- Two `EmbeddedRuntime`s sharing one `EmbeddedWriteFanoutAdapter`: a commit in process A fans out a
  `Transition` to a subscriber on process B (proves the seam-row-4 publish boundary), with `originId`
  dedup verified.
- Typing/presence over `EphemeralPublish` reaches other subscribers as a `Broadcast` while the
  DocStore commit log length is unchanged (proves seam-row-5 log bypass).

### 15.4 Reserved harnesses (land with the feature)
- **Binary-delta vs full-snapshot equivalence fuzzer** (when `BsatnServerMessageCodec` lands):
  apply deltas to the client's last-acked state and assert byte-equality with a full re-snapshot;
  inject version gaps and assert resync recovery.
- **OCC conflict cases & order-preserving codec round-trip/ordering** are owned by the
  `occ-transactor` and `index-key-codec` components respectively; the sync tier consumes their
  guarantees and re-uses `compareIndexKeys` in the interval-tree differential test above.

---

## 16. Open issues / cross-component contracts to confirm

1. **Byte-key representation (with `index-key-codec`).** We assume `Uint8Array` keys, `endKey===null`
   = +∞, point range `endKey===startKey`, comparison only via `compareIndexKeys`. Confirm the codec
   exports match (esp. `serializeKeyRange`/`deserializeKeyRange` base64).
2. **`SyncUdfExecutor` composition (with `occ-transactor` + executor).** Who owns OCC retry (we
   assume the executor), and the exact `authIndependent`/`readTables` derivation. Confirm
   `commitTimestamp` is omitted for pure-read/no-write mutations so we don't emit empty `Transition`s.
3. **Originator inclusion vs exclusion.** Default includes the originating session in the post-commit
   `Transition`; `excludeClientId` is an opt-in flicker optimization tied to client optimistic
   updates. Confirm the client SDK's optimistic-reconciliation expectation before defaulting either
   way (cross-query optimistic effects need explicit flicker/rollback tests).
4. **Table-write-timestamp retention.** `tableWriteTimestamps`/`recentWriteRanges` grow with table
   cardinality × write rate. Pin a concrete eviction policy + metric so it isn't a slow memory leak.
5. **Coalescing window default.** Immediate (`0`) at Tier 0; pick a Tier-2 default that cuts
   redundant re-runs under bursty fan-out without adding perceptible latency.
6. **`authIndependent` audit.** The only barrier to cross-principal cache leakage; must be derived
   conservatively and audited end-to-end (security-relevant).
7. **Change-stream discontinuity policy.** "Re-run all active subscriptions on a gap" is safe but a
   potential thundering herd at Tier 2; may need staggering/jitter and an explicit
   at-least-once-with-dedup contract on the distributed adapter.
8. **Reconnect/rebinding ordering.** Concurrent messages arriving mid-rebind under the session lock
   need a pinned ordering spec + dedicated tests to guarantee no lost subscriptions.
9. **Interval-tree balancing.** Decide self-balancing vs periodic rebuild before enabling
   `matchMode:"range"` in production (deferred; table-level is the v1 default).
10. **Binary-delta state contract (our divergence).** Diff-based `QueryUpdated` requires the server to
    track each client's last-acked result keyed by `StateVersion`; design the fallback-to-snapshot
    path and the fuzzing harness before shipping it.
