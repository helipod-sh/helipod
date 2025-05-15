---
title: Internals — Reactive Subscriptions & Sync Protocol
status: extracted (clean-room notes; concave studied as reference)
---

# Reactive Subscriptions & Sync Protocol

> Clean-room architecture notes for **Stackbase**. We studied concave (FSL-1.1-Apache-2.0)
> `.d.ts` contracts to understand the shape of the problem, then describe here, in our own
> words, the tier **we** intend to build. Nothing below is copied source; concave is cited
> only as the reference implementation we benchmarked against.

---

## Purpose & the separate sync tier

Live queries need a component that sits between **storage/execution** (the transaction engine
that runs query/mutation functions) and the **connected clients** (browser/mobile sockets).
Its single job: when data changes, figure out *which* currently-subscribed queries are now stale,
re-run only those, and push the new results to exactly the clients watching them.

We keep this as its **own tier** for three reasons concave's layout makes obvious:

1. **Different scaling axis.** Storage scales with data volume and write throughput; the sync
   tier scales with the number of *open connections* and *active subscriptions*. A single
   document write can fan out to thousands of sockets. Co-locating these would couple two
   unrelated load profiles.
2. **Platform-agnostic core.** In the reference, the protocol logic is deliberately decoupled
   from any concrete runtime (their `protocol-handler` carries a doc comment to that effect and
   talks only to abstract `SyncWebSocket` / `SyncUdfExecutor` interfaces). The same handler can
   run behind Cloudflare Durable Objects, a Bun/Node WebSocket server, or an in-process loopback.
   We adopt the same separation so the reactive logic is testable without a network.
3. **Independent failure domain.** A slow consumer or a flood of subscription churn should be
   absorbable (backpressure, rate limits, drop policies) without stalling the transaction engine.

The contract surface we mirror:

- `SyncUdfExecutor` — the *only* thing the sync tier needs from execution: `executeQuery`,
  `executeMutation`, `executeAction`. Each returns the result **plus reactivity metadata**: a
  query returns its `readRanges` and a `snapshotTimestamp`; a mutation/action returns its
  `writtenRanges` / `writtenTables` and a `commitTimestamp`. This metadata is the entire basis
  of reactivity — the sync tier never inspects user data semantically, only the read/write *sets*.
- `SyncWebSocket` — minimal transport: `send(string)`, `close(code, reason)`, `readyState`, and
  an optional `bufferedAmount` (for backpressure). Deliberately tiny so any runtime can satisfy it.

**Stackbase note:** we treat the read/write set as the reactivity currency exactly as concave
does, but we intend our metadata to be richer over time (binary-encoded deltas rather than full
JSON result replacement — see the final section).

---

## Subscription manager

A **subscription** in our model = `(client, queryId) → query identity + recorded read set`.

Key pieces we carry over from the reference `SubscriptionManager`:

- **Content-addressed query identity.** A query is hashed from `(udfPath, args, authSubject,
  componentPath)` into a `QueryHash`. Two clients issuing the same query with the same auth
  collapse to the same hash, so we store one logical subscription and fan its result out to many
  clients. Each client keeps its *own* local `queryId`, mapped to the shared hash. (Reference
  helpers: `computeQueryHash`, `computeQueryCacheKey`.)
- **Dependencies as a read set.** `subscribe(clientId, queryId, { ranges }, queryHash,
  snapshotTimestamp)` records the `KeyRange[]` the query touched. A `KeyRange` is
  `{ tableId, startKey, endKey, isPoint }` with keys as `ArrayBuffer` in proper lexicographic
  encoding (point read ⇒ `startKey === endKey`, `endKey === null` ⇒ unbounded/infinity).
- **Granularity decision — table-level matching, range-capable index.** This is the most
  important honest observation from the reference. The `SubscriptionManager` doc comment states
  it deliberately tracks dependencies and invalidations at the **table level** for *correctness
  over cleverness*: any write to table `X` invalidates any query that read from `X`. Yet the
  module also ships an `IntervalTree` and keeps `recentWriteRanges`, and the protocol handler has
  a `broadcastUpdates` path described as "fine-grained range-based tracking." So the reference
  keeps both tools available: cheap-and-correct table matching as the default, with the interval
  tree as the substrate for finer range-overlap matching. **Stackbase will start table-level for
  correctness and turn on interval-tree range matching as a measured optimization, not a default.**
- **OCC-aware (race-free) registration.** There is a window between when a query reads its
  snapshot and when its subscription is actually registered; a write landing in that gap would be
  missed. The manager tracks the latest write timestamp **per table** (`recordWrites(ranges, ts)`,
  `tableWriteTimestamps`). On `subscribe`, it compares the query's `snapshotTimestamp` against the
  latest write timestamp of each table it depends on and returns `{ needsRerun: boolean }`. If a
  newer write exists, the caller immediately re-runs the query before trusting the cached result.
  We adopt this "register, then check for missed writes" handshake verbatim in spirit.
- **Matching writes → affected subscriptions.** `findAffectedQueries(writtenRanges)` returns
  `Map<ClientId, Set<QueryId>>` — the precise set of (client, query) pairs to re-run. Lifecycle
  helpers: `unsubscribe`, `unsubscribeAll(clientId)` (on disconnect), `updateSessionId` (when a
  reconnect rebinds an anonymous session to its real id), plus `getStats` / `assertConsistency`
  for observability and invariant checking.
- **Bookkeeping hygiene.** Write-timestamp tables grow unbounded if untrimmed; the manager has
  `maybeCleanupTableWriteTimestamps` (lazy) and `forceCleanupTableWriteTimestamps`. We need an
  equivalent eviction policy.

---

## Interval tree (KEY)

**Problem it solves.** Given thousands of subscriptions, each holding a read set of key *ranges*,
and an incoming write set of key ranges, find every subscription whose read set **overlaps** the
write set — without scanning all subscriptions. Naively this is O(subscriptions × ranges) per
write. The interval tree makes it roughly **O(log n + k)**, where `n` is the number of indexed
intervals and `k` is the number of actual matches.

**The data structure** (reference `IntervalTree` / `Interval`):

- An `Interval` is `{ start: ArrayBuffer, end: ArrayBuffer | null, isPoint, data }`. `start`/`end`
  are lexicographically-ordered byte keys; `end === null` means +∞ (unbounded scan). `data` is the
  back-pointer to the subscription that registered this range.
- It is an **augmented binary search tree keyed on `start`**. Each node additionally caches the
  **maximum `end` key present anywhere in its subtree** (`maxOf` helper, treating `null` as
  infinity). This `subtreeMax` is what makes pruning possible.

**Insertion** (`insert` / `insertNode`): ordinary BST insert by comparing `start` keys
lexicographically (`compareArrayBuffers`), updating each ancestor's cached subtree-max on the way
down/up. Size counter maintained for `getSize`.

**The overlap query** (`findIntersecting(queryStart, queryEnd, isQueryPoint)`): this is the heart
of it. Recursive descent (`searchNode`) with the classic interval-tree pruning rule:

1. At a node, if the **left subtree's `subtreeMax` < `queryStart`**, no interval on the left can
   possibly reach the query window — **prune the entire left subtree.** This is the step that
   turns a linear scan into a logarithmic one.
2. Otherwise recurse left.
3. Test the current node's own interval against the query window with `intervalsIntersect`
   (two ranges `[aStart,aEnd]` and `[bStart,bEnd]` overlap iff `aStart ≤ bEnd` **and**
   `bStart ≤ aEnd`, with `null` ends treated as +∞ and point intervals handled via `isPoint`).
   Collect it into the result if it overlaps.
4. If the **node's own `start` ≤ `queryEnd`**, the query window may still extend into the right
   subtree, so recurse right; otherwise prune the right subtree too.

The collected `Interval.data` values are the matched subscriptions. Because matching is by byte-range
overlap, this naturally supports point reads, bounded range scans, and unbounded table scans in one
structure.

**Removal** (`remove` / `removeNode`): standard BST delete located by `intervalsEqual` (compare
`start`, `end`, and `isPoint`), repairing cached subtree-max values along the affected path.

**Stackbase plan.** Build the same augmented-BST-with-subtree-max structure. Two upgrades we are
considering: (a) self-balancing (red-black or weight-balanced) so adversarial insert order can't
degrade to O(n) — the reference's tree is a plain BST and could skew; (b) per-`tableId` interval
trees (one tree per keyspace) so a write only probes the tree for its own table, shrinking `n`
before the log factor even applies. We will keep the simple table-level Set match as the
correctness baseline and validate the interval tree against it in tests.

---

## Query cache

When many clients share a query hash, we should execute it **once** and reuse the result. The
reference `QueryCache` is an in-memory, dependency-tracked, TTL+LRU cache:

- **Entry shape** (`CachedQuery`): the `result` (JSON), `logLines`, the `readRanges` and
  `readTables` it depended on, an optional `snapshotTimestamp` and `trace`, a `cachedAt` stamp,
  and an `authIndependent` flag. `authIndependent` matters: a result that didn't read the auth
  context can be shared across users; one that did must be keyed per principal.
- **Keying.** Lookups use a string key derived from `(udfPath, args, componentPath, authKey)`
  (`computeQueryCacheKey`). The handler exposes `getCachedQueryResult(key)` /
  `populateQueryCache(key, entry)` so the protocol layer can short-circuit re-execution.
- **Dependency-indexed invalidation.** The cache keeps a reverse index `tableToKeys` mapping each
  table to the set of cache keys that read it, so `invalidateByTables(tables)` drops exactly the
  affected entries in roughly O(affected) rather than scanning the whole cache. This is the cache's
  mirror of the subscription manager's table-level matching.
- **Bounding.** `maxEntries` (LRU eviction via `evictIfNeeded`) and `ttlMs` (staleness) keep memory
  bounded; `delete`, `clear`, and a `size` getter round it out.

There is also a broader, async **`CacheStrategy` interface** in the reference (`get`/`set`/
`invalidate`/`clear` over `CacheKey {query_path, args_hash}` and `CachedResult { value, cached_at,
dependencies }`). It is explicitly framed as pluggable: a **simple** mode (TTL or no-op) versus a
**distributed** mode (dependency-tracked with fingerprints, invalidated by change-stream deltas).
**Stackbase** will expose the same strategy seam: Tier 0 ships the in-memory `QueryCache`; a later
distributed tier can swap in a shared cache invalidated off the change stream without touching the
protocol handler.

---

## The sync protocol

Messages are JSON today (parsed/encoded via `parseClientMessage` / `encodeServerMessage`;
`u64`/timestamps travel as strings — `Long` — and convert to `bigint` internally). The protocol is
**versioned by monotonic counters**, not by message ordering: a `StateVersion` is
`{ querySet, ts, identity }`, and the client and server reconcile by base/target versions.

### Client → server messages

- **`Connect`** `{ sessionId, connectionCount, lastCloseReason, maxObservedTimestamp? }` — opens or
  resumes a session. `connectionCount`/`lastCloseReason` aid reconnect diagnostics;
  `maxObservedTimestamp` lets the server know how fresh the client already is. Handler learns the
  real `sessionId` here and may `updateSessionId` to rebind the socket's provisional id.
- **`ModifyQuerySet`** `{ baseVersion, newVersion, modifications: (Add | Remove)[] }` — **this is how
  the query set is diffed.** The client never resends its whole subscription list; it sends only the
  delta. `Add` = `{ queryId, udfPath, args, journal?, componentPath? }`; `Remove` = `{ queryId }`.
  `baseVersion → newVersion` makes the change idempotent and gap-detectable: the server applies the
  diff only if `baseVersion` matches the session's current `querySetVersion`.
- **`Mutation`** `{ requestId, udfPath, args, componentPath? }` — a write request; `requestId`
  correlates the eventual response.
- **`Action`** `{ requestId, udfPath, args, componentPath? }` — like a mutation but for
  side-effecting/non-transactional functions.
- **`Authenticate`** `{ tokenType: Admin|System|User|None, value?, baseVersion, impersonating? }` —
  sets/refreshes the session principal; `baseVersion` is the `identityVersion` it builds on.
- **`Event`** — generic client telemetry/event channel.

### Server → client messages

- **`Transition`** `{ startVersion, endVersion, modifications: StateModification[] }` — **the core
  reactive update.** It says "advance from `startVersion` to `endVersion`, applying these query
  changes." Each `StateModification` is one of:
  - `QueryUpdated { queryId, value, logLines, trace?, journal }` — new result for a query.
  - `QueryFailed { queryId, errorMessage, errorData, logLines, journal }` — query threw.
  - `QueryRemoved { queryId }` — acknowledges a removed subscription.
  Built via `makeTransitionMessage(startVersion, endVersion, modifications)` and
  `makeStateVersion(querySet, identity, ts)`. Because a transition is bracketed by start/end
  versions, the client applies it atomically and can detect a missed transition (version gap) and
  resync.
- **`MutationResponse`** `{ requestId, success, result | error, ts?, logLines, trace? }` — success
  carries the commit `ts`; failure carries an error string + `errorData`.
- **`ActionResponse`** — same shape, no timestamp (actions aren't part of the snapshot timeline).
- **`AuthError`** `{ error, baseVersion, authUpdateAttempted }` and **`FatalError`** `{ error }`.
- **`Ping`** — heartbeat (see Session management).

### The `journal` and gapless pagination

A `QueryJournal` (opaque string, or `null` for empty) records decisions a query made on first run —
chiefly **pagination end cursors** — and is replayed on every re-execution so a reactive paginated
query keeps ending at the same cursor (no rows skipped or duplicated as data shifts underneath). The
client stores the journal from a `QueryUpdated` and sends it back inside the corresponding `Add`.

### Optimistic updates

The protocol's request/response correlation (`requestId` on mutations) plus version-bracketed
`Transition`s is exactly what a client needs to apply an **optimistic** mutation result locally and
then reconcile: it can show the predicted state immediately, and when the authoritative
`MutationResponse.ts` and the following `Transition` arrive, roll the optimistic layer forward or
back to the server truth. The server side stays authoritative; optimism is a client concern that the
version/timestamp metadata enables. Note `updateOriginatingSession` / the `excludeSessionId` path in
`broadcastUpdates`: the session that issued a mutation is **excluded** from the fan-out broadcast
because it already gets the authoritative result through its own `MutationResponse` + its own query
re-run, avoiding a double update / flicker.

### End-to-end: a write becomes a client update

1. Client sends `Mutation`. Handler (`handleMutation`) runs it through `executeMutation`, getting
   back `result`, `writtenRanges`/`writtenTables`, and a `commitTimestamp`.
2. Handler returns a `MutationResponse` to the originating client and calls `notifyWrites` with a
   `WriteInvalidation { writtenRanges?, writtenTables?, commitTimestamp?, snapshotTimestamp? }`.
3. `notifyWrites` records the write (advancing `lastObservedWriteTimestamp`, `recordWrites`),
   invalidates the query cache by table, and asks the subscription manager
   (`findAffectedQueries` / the interval-tree overlap) for the affected `(client, query)` set.
4. `broadcastUpdates` re-runs each affected query (`rerunSpecificQueries` →
   `executeReactiveQuery`), producing fresh `StateModification`s, wraps them in a `Transition`
   advancing the session's `ts`, and `send`s it to each affected session (excluding the originator).

### Sub-primitive: `executeReactiveQuery`

`query-execution.ts` factors out the "run one subscribed query and update its subscription" step:
given a `QueryDescriptor` (`queryId, udfPath, args, journal?, componentPath?`), the session/auth,
the `SyncUdfExecutor`, the `SubscriptionManager`, and optionally the `QueryCache`, it executes the
query, **re-records its read ranges** (so the subscription's dependency set tracks data that has
moved), optionally re-subscribes (`shouldResubscribeAfterRerun`), and returns a single
`StateModification`. We mirror this as the atomic unit of reactive re-execution.

---

## Session management

`SyncSession` holds per-connection state: the `websocket`, a `pingTimer`, an async `lock`
(serializes operations on one session), the `querySetVersion` / `identityVersion` / `timestamp`
counters, the `activeQueries` map (`queryId → Add`), the `auth` context, and the outbound
`messageQueue` + drain state. Cross-cutting protections, all wired into `SyncProtocolHandler`:

- **Heartbeat** (`SessionHeartbeatController`, `PING_INTERVAL_MS = 15000`): on a timer it checks
  `readyState === OPEN` and fires `onPing` (sends a `Ping`), then `scheduleNext`. `start`/`clear`
  tie the timer to session lifetime so dead sockets are detected and cleaned up.
- **Backpressure / slow consumers** (`SessionBackpressureController`): every outbound message goes
  through `sendSerialized`. It watches the socket's `bufferedAmount` against a `highWaterMark`; when
  the consumer is too slow it begins **draining** (`startDraining` / `drainQueue`) into the
  session's `messageQueue`, bounded by `bufferLimit`. If the queue overflows or the client stays
  slow past `slowClientTimeoutMs`, messages are **dropped** (counted in `droppedMessages`) rather
  than letting one slow client exhaust server memory. `SyncSession` exposes `queueDepth` /
  `queuedBytes` for monitoring, and the handler aggregates `getBackpressureStats()`
  (`sessions, totalQueuedMessages, totalDroppedMessages, sessionsWithBackpressure`).
- **Per-session locking & timeouts** (`withSessionLock`, `withOperationTimeout`,
  `operationTimeoutMs`): operations on a session run serialized under its `lock`; a timeout bounds
  *client-visible* wait time (it does not cancel the underlying work). This prevents interleaved
  mutation/query handling from corrupting version counters.
- **Rate limiting** (`consumeRateLimit`, `maxMessagesPerWindow`, `rateLimitWindowMs`): caps client
  messages per rolling window per session.
- **Subscription cap** (`maxActiveQueriesPerSession`, `computeProjectedActiveQueryCount`): bounds how
  many active subscriptions one session can hold, rejecting `ModifyQuerySet` adds that would exceed it.

**Stackbase** adopts all four guardrails (heartbeat, backpressure-with-drop, lock+timeout, rate
limit + subscription cap) as non-negotiable for the standalone tier; the in-process tier can run a
trivial pass-through transport but should keep the same controllers behind feature flags.

---

## Sync transport abstraction

The reactive logic talks only to interfaces, so the transport is swappable:

- **`SyncWebSocket`** (server-facing): `send`, `close`, `readyState`, optional `bufferedAmount`.
- **`WebSocketConnection`** (`abstractions/websocket-connection.ts`): a fuller runtime-facing
  interface with a `WebSocketReadyState` enum (`CONNECTING/OPEN/CLOSING/CLOSED`), `send`,
  `close`, and `onMessage`/`onClose`/`onError` registration. The doc comment lists the intended
  backends: Cloudflare Workers, Bun, Node `ws`, Deno.
- **Client transport**: `createSyncTransportWebSocketConstructor(syncAddress)` returns a
  `WebSocket`-compatible constructor pointed at the sync endpoint, so the client SDK is agnostic to
  how the socket is actually established.

This is what lets the *same* `SyncProtocolHandler` run in three deployment shapes:

- **WebSocket server** (Bun/Node `ws`) — a standalone process.
- **Durable Object** (Cloudflare) — the handler lives inside a DO that owns the sessions for a shard;
  the DO's `state.acceptWebSocket` provides the socket.
- **Loopback** — an in-memory transport where `send` just enqueues into a local handler, for tests
  and for the in-process tier (no real network).

**Stackbase** defines one transport interface (send/close/readyState/bufferedAmount +
message/close/error callbacks) and ships three adapters: WS, DO, and loopback. The protocol handler
never imports a concrete socket type.

---

## How Stackbase reimplements this

**Two deployment tiers, one protocol:**

- **Tier 0 — in-process.** The sync handler runs inside the same process as the transaction engine,
  wired to a **loopback transport**. The `SyncUdfExecutor` is a direct function call into execution;
  `notifyWrites` is invoked synchronously after a local commit. This is the dev/embedded default —
  zero network, full reactivity, instant feedback. Backpressure/rate-limit controllers exist but are
  effectively no-ops.
- **Tier 2 — standalone sync tier.** The handler runs as its own service (WS server or Durable
  Object per shard), receiving write notifications from the engine over the change stream and serving
  many sockets. Here the session guardrails (heartbeat, backpressure-with-drop, locks, rate limits,
  subscription caps) and the shared/distributed `CacheStrategy` matter. Scales on connection count
  independently of storage.

**What we keep from concave:** the read/write-set-as-reactivity-currency model; content-addressed
query dedup; the OCC "subscribe-then-check-for-missed-writes" handshake; the interval tree (augmented
BST + subtree-max) for range overlap, layered over a table-level correctness baseline; version-
bracketed `Transition`s with a `ModifyQuerySet` diff protocol; the journal for gapless reactive
pagination; and the swappable transport seam.

**Where we diverge — the binary delta protocol goal.** The reference replaces a query's *entire*
JSON result on every `QueryUpdated`. That is simple and correct but wasteful when a 10k-row query
changes one row. Stackbase's target is a **binary delta protocol**: each `QueryUpdated` carries a
compact, binary-encoded diff against the client's previously-acknowledged result (keyed by the
version the client last confirmed), with full-snapshot resync as a fallback on version gaps. The
version counters (`querySet`/`identity`/`ts`) already present in the protocol give us the
acknowledgment points we need to diff against; we extend the message encoding, not the state model.
We also intend per-`tableId` interval trees and a self-balancing tree variant to harden the overlap
index against skew.

---

## Open questions / risks

- **Table-level vs range-level default.** The reference defaults to table-level matching for
  correctness and keeps the interval tree available but (per its own comment) under-leveraged. We
  must decide *per workload* when fine-grained range matching pays for its complexity, and we need a
  differential test that asserts the interval tree never *under*-reports relative to the table-level
  baseline (a missed invalidation is a silent correctness bug).
- **Unbalanced interval tree.** The reference tree is a plain BST keyed on `start`; pathological
  insert order degrades to O(n) per query. Decide between self-balancing vs periodic rebuild.
- **Write-timestamp map growth.** `tableWriteTimestamps` and `recentWriteRanges` grow with table
  cardinality and write rate; the lazy cleanup needs a concrete policy and metrics, or it becomes a
  slow memory leak.
- **Auth-dependent cache sharing.** The `authIndependent` flag is the only thing preventing one
  user's row-secured result from leaking to another via the shared cache. This must be derived
  conservatively (default to auth-dependent) and audited.
- **Backpressure drop semantics.** Dropping messages keeps the server alive but means a slow client
  can miss a `Transition` and silently diverge. The client must treat any version gap as "resync
  from scratch," and we need to verify the client actually does (and that resync is cheap enough).
- **Binary delta complexity (our addition).** Diff-based updates add a stateful contract (server must
  know what each client last acknowledged) and a fallback path. Risk of subtle divergence bugs;
  needs a fuzzing harness comparing delta-applied state to full-snapshot state.
- **Optimistic update reconciliation.** Excluding the originating session from broadcast assumes its
  own `MutationResponse` + local re-run fully covers it; cross-query optimistic effects (a mutation
  affecting queries the originator also subscribes to) need explicit testing for flicker/rollback.
- **Reconnect/session rebinding races.** `updateSessionId` rebinds a provisional socket id to the
  client's real `sessionId` on `Connect`; concurrent messages arriving mid-rebind under the session
  lock need careful ordering to avoid lost subscriptions.
