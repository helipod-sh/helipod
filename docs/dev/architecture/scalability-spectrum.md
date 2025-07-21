---
title: Scalability Spectrum — One App, from a $5 VPS to WhatsApp
status: decided
audience: engineering (internal)
---

# Scalability Spectrum — One App, from a $5 VPS to WhatsApp

> This document makes the [scalability mandate](./strategy.md#the-scalability-mandate-explicit)
> concrete. Stackbase must serve the **entire spectrum on the same app code** — the same
> `convex/` functions, the same `useQuery`, the same core engine. The [Foundation slice](./internals/README.md)
> builds only **Tier 0** (one binary, embedded SQLite), but **every interface it defines must
> reserve the seams** that let the large end be reached **without rewriting app code or the
> core engine**. This is the spec for which seams those are, why, and what carries them.
>
> It is the companion to the [system design](./system-design.md) (the North Star) and the
> end-user [scaling blueprint](../../enduser/deploy/scaling.md) (the deployment view). This doc
> is the *internal* bridge: it maps a real WhatsApp-class workload onto our reactive-transaction
> model and proves the seams are sufficient. For the concrete **deployment matrix** (single binary,
> npm without Docker, Docker, a droplet, Railway/Fly, edge) and the **language decision** behind it,
> see [`deployment-and-language.md`](./deployment-and-language.md).

## 1. The two endpoints

The product is defined by its two extremes and the promise that one codebase spans them.

| | **Endpoint A — PocketBase-class** | **Endpoint B — WhatsApp-class** |
|---|---|---|
| **Shape** | One binary, embedded SQLite (WAL), zero config | Distributed fleet, multi-region, sharded writes |
| **Concurrency** | 1 – a few thousand connections | Hundreds of millions of concurrent WebSockets |
| **Throughput** | A few writes/sec | ~10⁵ messages/sec aggregate (~10¹¹/day), group fan-out |
| **Data** | Megabytes – low GB | Petabytes; per-conversation infinite history |
| **Realtime** | Reactive `useQuery` over loopback | Reactive queries **+** presence/typing/read-receipts at keystroke frequency |
| **Ops** | `docker run` one container, one volume | Autoscaled sync fleet + sharded committers + coordinator |
| **Hosting** | $5 VPS, a laptop, an Electron/Tauri desktop app | Many machines across regions |
| **What it demands** | Minimal footprint, instant start, no sidecars | Horizontal write scale, horizontal connection scale, ephemeral fan-out, backpressure, stable history |

**The invariant that must hold across the whole table:** the app's `convex/` query/mutation
functions, its schema, and the client's `useQuery`/`useMutation` calls are **byte-for-byte
identical** at both endpoints. Moving A → B changes *deployment config and adapters*, never app
code and never the reactive core. That invariant is the product; everything below exists to keep
it true.

## 2. WhatsApp-style chat, mapped onto our reactive-transaction model

To prove the seams are sufficient we work the hardest realistic case end-to-end: a group chat
messenger. The app schema is ordinary Stackbase code:

```ts
// convex/schema.ts — identical at Tier 0 and Tier 2
conversations: defineTable({ title: v.string(), memberIds: v.array(v.id("users")) })
messages: defineTable({
  conversationId: v.id("conversations"),   // <-- the shard key (see §2.1)
  authorId: v.id("users"),
  body: v.string(),
}).index("by_conversation", ["conversationId"])   // implicitly + _creationTime + _id

readWatermarks: defineTable({                // durable, but coarsened: one row per (conv,user)
  conversationId: v.id("conversations"),     // shard key
  userId: v.id("users"),
  lastReadMessageId: v.id("messages"),
}).index("by_conv_user", ["conversationId", "userId"])

// presence / typing / "seen just now" are NEVER tables — they ride the ephemeral path (§2.3)
```

`sendMessage` is an ordinary mutation; the message list is an ordinary paginated query. Nothing
in this code knows what tier it runs on. The rest of this section is how the *engine* makes that
same code survive WhatsApp load.

### 2.1 Conversation = shard ⇒ single-writer-per-shard (unbounded write scale)

WhatsApp's aggregate write rate is enormous, but **any single conversation has a bounded write
rate** — even a huge group sustains only a few messages/second. The whole scaling trick falls out
of that observation:

- **The conversation is the shard key.** Every `message` and `readWatermark` carries
  `conversationId`; the storage/commit path is partitioned on it. All documents of one
  conversation **co-locate on one shard**.
- **One single-writer transactor per shard.** Within a conversation, messages serialize through
  exactly one writer assigning monotonic commit timestamps — so we keep total order,
  serializability, and *cheap* OCC (validation only asks "did anything I read change since my
  snapshot?", never cross-writer lock coordination — see [internals/02](./internals/02-transactions-consistency.md)).
- **Across conversations there is zero write contention.** Total write throughput scales
  **linearly with shard count**, not by weakening consistency. 10¹¹ messages/day spread over
  billions of conversations means each single-writer shard sees a trivial rate. We add capacity by
  adding shards, never by making a shard faster.

This is the strategy doc's non-negotiable seam #1: *a conversation is a shard → single-writer-per-shard
= unbounded write scale.* **Tier 0 has exactly one shard** (the whole SQLite DB, one
`TimestampOracle`), but the commit path, the lock, the oracle, and the invalidation delta are all
**already scoped to a `shardId`** so Tier 2 splits per-conversation with no engine change. The
Tier 2 realization is `ShardRouter.getShardForDocument(docId)` (consistent hashing on the shard
key → committer); the Foundation obligation is that the shard key exists in the data model and
threads through `DocStore.write`, the `Transactor`, and `CommitResult` from day one even while it
is always `"default"`.

> **Constraint this imposes on app design (documented, not hidden):** a transaction is
> **shard-local** — an atomic write spanning two conversations is out of scope (it would need
> cross-shard 2PC). Chat never needs it; we keep the single-writer serializability proof local to
> a shard. Cross-cutting reads (a user's conversation list) are fine — they are reads, fanned by
> the sync tier, not cross-shard writes.

### 2.2 A connection-sharded sync fleet (the WebSocket fan-out)

Storage scales with data/writes; the **sync tier scales with open connections and active
subscriptions** — a completely different axis (one message write can fan out to thousands of
sockets). Hundreds of millions of sockets cannot live in one process, so the sync tier is its own
tier with its own failure domain ([internals/03](./internals/03-reactivity-sync.md)):

- **Clients are sticky-hashed across a fleet of sync nodes** via rendezvous hashing
  (`ShardRouter.getSyncNodeId(clientId)`), so a client's whole subscription set stays on one node.
- **Each node holds sessions + subscriptions + a query-result cache** for its slice of
  connections, and re-runs only the queries a write actually touched.
- **The reactive logic is transport-agnostic.** The `SyncProtocolHandler` talks only to abstract
  `SyncWebSocket` / `SyncUdfExecutor` interfaces and never imports a socket type — so the *same
  handler* runs in-process behind a loopback socket (Tier 0) or as a fleet node behind a real WS
  server / Durable Object (Tier 2).

This is non-negotiable seam #2. **Tier 0 runs one "node" in-process** with the loopback transport
and the "Simple" router that always returns the single local instance. Foundation keeps the seam
open simply by **building the sync handler against the abstract transport from day one** and never
letting a concrete socket type leak into the reactive logic.

### 2.3 An ephemeral broadcast path that bypasses the durable log (presence / typing / read-receipts)

This is the subtle one, and the most important to get right in Foundation because retrofitting it
is a protocol break. Presence ("online"), typing indicators, and live read-receipts are:

- **High frequency** — typing fires on every debounced keystroke; in a 256-member group that is
  hundreds of events/second per conversation.
- **Individually worthless to persist** — nobody needs the durable history of "Alice was typing at
  10:03:01.234".
- **Wrong to route through the transactor.** If they were mutations they would (a) bloat the
  append-only MVCC log with infinite ephemeral noise, (b) serialize through the conversation's
  single writer and *contend with real messages*, and (c) trigger full OCC validation + index
  maintenance + subscription recompute for a signal that is stale in two seconds.

So they take a **separate, non-durable path**:

- Presence/typing/live-"seen" are **not documents**. They are ephemeral events **published to a
  per-conversation topic** and delivered **only to currently-connected subscribers**, last-writer-wins,
  TTL'd in memory. They **never become `DocumentLogEntry` rows, never touch OCC, never hit the
  commit log.**
- They **share the client's socket, session, and backpressure machinery** with reactive updates,
  but ride a **distinct server→client message kind** (a `Broadcast`/ephemeral frame) that is *not*
  derived from a commit.
- **Read-receipts split in two:** the *durable* part is the `lastReadMessageId` **watermark** — a
  tiny row overwritten in place (one per conversation/user), a coarsened normal mutation, **not**
  one row per read event. The *live* "seen just now" pulse is ephemeral.

This is non-negotiable seam #3. The Foundation obligation is precise and structural: **the sync
protocol's `ServerMessage` union must be versioned and extensible with room for a non-commit
`Broadcast` kind, and the sync handler must expose an ephemeral-broadcast ingress distinct from
`notifyWrites`.** If Foundation hard-wires "every server→client message is a `Transition` derived
from a write invalidation," ephemeral fan-out becomes impossible to add without breaking the wire.
At Tier 0 the ephemeral channel is a trivial in-process delivery to local subscribers; at Tier 2 it
becomes a fleet-wide pub/sub on a separate, non-durable topic — the *interface* is what Foundation
must reserve.

### 2.4 The transactor → sync pub/sub fan-out seam

How does a committed message reach every sync node holding a subscriber? Through a **publish
boundary**, never a direct call:

- **Tier 0:** a mutation commits and the runtime calls `notifyWrites` on the in-process sync
  handler — but *via* a write-fanout publisher abstraction, not by reaching into the handler.
- **Tier 2:** the conversation's committer emits an `OplogDelta`/`ChangeDelta`
  (`{commit_ts, written_ranges, written_tables, shard_id}`, wire-serializable) onto a **change
  stream**; every sync node tailing that stream calls its *local* `notifyWrites`. The transactor
  fans out to N nodes through the stream instead of N point-to-point posts.

The seam is the indirection itself: the transactor **publishes** invalidations and the sync tier
**subscribes**; they are never directly coupled. The payload is serializable from day one
(`SerializedKeyRange`, not in-memory `ArrayBuffer`s). Foundation reserves it with
`EmbeddedWriteFanout` / `EmbeddedWriteFanoutAdapter` (`publish(payload)` / `subscribe(listener)`):
the default Tier 0 adapter is an in-memory channel; swap it for BroadcastChannel / Redis / Queues
and the *same* fan-out spans many processes, each ignoring its own `originId`. The consumer side is
`ChangeStreamConsumer` (`start`/`stop`/`onChanges`/`getCurrentPosition`).

### 2.5 Backpressure for slow consumers

At fan-out scale, some consumers are slow (a phone on a subway). A slow consumer must never (a)
exhaust sync-node memory, (b) head-of-line-block other clients on the node, or (c) stall the
transactor. The mechanism ([internals/03](./internals/03-reactivity-sync.md)):

- Every outbound frame passes through a `SessionBackpressureController` that watches the socket's
  `bufferedAmount` against a high-water mark, **drains into a bounded queue**, and **drops** frames
  past the buffer limit / slow-client timeout (counted, observable).
- Dropping is safe **because the protocol is version-bracketed**: a `Transition` advances
  `startVersion → endVersion`, so a client that misses one detects the **version gap and resyncs
  from scratch**. A dropped frame degrades to a resync, never to silent divergence.
- A heartbeat (`SessionHeartbeatController`) reaps dead sockets; rate limits and a per-session
  subscription cap bound abuse.

Foundation builds these controllers into `SyncSession` from day one (effectively no-ops on the
Tier 0 loopback) and — critically — keeps `bufferedAmount` in the `SyncWebSocket` interface and
makes the client treat **any version gap as full resync**. That client behavior is what makes
Tier 2 message-drops correct; it cannot be bolted on later.

### 2.6 History via MVCC cursor pagination (infinite scrollback)

A conversation with millions of messages over years must paginate **efficiently and stably** — no
skips or duplicates as new messages arrive at the head while you scroll the tail. Our MVCC log +
order-preserving codec deliver this for free:

- Messages are read via `by_conversation` (`[conversationId, _creationTime, _id]`),
  `.order("desc").paginate({ cursor })`.
- The cursor carries `(indexKey, _id)`, so resumption is a **stable position** — a new head insert
  with the same field values lands deterministically relative to the cursor, never shifting it.
- Each page reads at an **MVCC snapshot** (`index_scan(indexId, tableId, readTimestamp, …)`), so a
  long scroll sees a consistent point in logical time.
- The recorded read range is the **page's interval only**, not the whole index — so reactive
  pagination doesn't over-invalidate older pages at fan-out scale.
- The `QueryJournal` pins each paginated query's end cursor across re-execution, so a *reactive*
  paginated list stays gapless as data shifts underneath.

The punchline: `paginate()` over a billion-message conversation is the **same app code** as over a
100-row dev table. The Foundation obligations are the order-preserving `encodeIndexKey` (proven by
property tests), the `(indexKey, _id)` `IndexCursor`, and the `QueryJournal` — all Tier 0
deliverables. (Infinite *retention* — never GC'ing a live message revision while compacting dead
intermediate ones — is a known later policy keyed off the oldest live snapshot; the *read path* is
done in Foundation.)

## 3. The seams the Foundation MUST reserve

This is the contract. For each WhatsApp-scale demand: what it forces, the seam Foundation reserves
(and its trivial Tier 0 implementation), and **the interface that carries the seam**. A Foundation
interface that omits one of these columns is a design bug — it would force an app-code or
core-engine rewrite to reach Endpoint B, breaking the product invariant.

| # | WhatsApp-scale demand | What it forces | Seam Foundation reserves (Tier 0 impl) | Interface that carries the seam |
|---|---|---|---|---|
| 1 | **Unbounded write throughput** (10¹¹ msg/day) | Partition writes by conversation; one single writer per partition | Shard key in the data model; per-shard transactor + oracle; `shardId` on every commit/invalidation. *Tier 0: one shard `"default"`.* | `ShardKey`/partition field on writes · `Transactor` (per-shard) · `TimestampOracle` (one per shard) · `CommitResult.shardId` · `ShardRouter.getShardForDocument` *(Tier 2)* |
| 2 | **Write co-location** (a conversation on one shard) | Shard key derived from a *field* (`conversationId`), not a random doc id | Shard key resolved from the document; `DocStore.write` accepts a shard scope. *Tier 0: ignored.* | `ShardKeyResolver` · `DocStore.write(documents, indexes, strategy, shardId?)` |
| 3 | **Hundreds of millions of connections** | Sync is its own tier; clients sticky-hashed across a fleet | Transport-agnostic sync handler; rendezvous client→node hashing. *Tier 0: one in-process node, loopback.* | `SyncProtocolHandler` · `SyncWebSocket` · `SyncUdfExecutor` · `ShardRouter.getSyncNodeId` *(Tier 2)* |
| 4 | **Transactor→sync fan-out across processes** | Invalidations *published* to pub/sub, not direct-called; payload serializable | Commit emits a serializable delta to a write-fanout publisher; sync subscribes. *Tier 0: in-memory channel.* | `EmbeddedWriteFanout` / `EmbeddedWriteFanoutAdapter` (publish/subscribe) · `ChangeStreamConsumer` · `WriteInvalidation` / `OplogDelta` (with `SerializedKeyRange`) |
| 5 | **Presence / typing / read-receipts** at keystroke frequency | A non-durable path that bypasses the log, OCC, and the single writer | Ephemeral broadcast channel **distinct from `notifyWrites`**; extensible message catalog. *Tier 0: in-process delivery to local subscribers.* | `EphemeralBroadcast` / `PresenceChannel` · extensible `ServerMessage` union (`Broadcast` kind) · `SyncProtocolHandler` ephemeral ingress |
| 6 | **Slow consumers** on bad networks | Bounded buffers, drop-and-resync, never stall the engine | Per-session backpressure + drop + heartbeat; version-gap → full resync. *Tier 0: no-op controllers, same code path.* | `SyncWebSocket.bufferedAmount` · `SessionBackpressureController` · `SessionHeartbeatController` · version-bracketed `Transition` / `StateVersion` |
| 7 | **Infinite scrollback history** | Stable, snapshot-consistent pagination over huge tables | Order-preserving key codec + `(indexKey,_id)` cursors + journal + MVCC reads. *Tier 0: identical mechanics.* | `encodeIndexKey` / `compareIndexKeys` · `IndexCursor` · `QueryJournal` · `DocStore.index_scan(readTimestamp, …)` |
| 8 | **Read-scaling** (many readers; query dedup) | Stateless, poolable executor; shared result cache by content hash | `UdfExec` stateless contract; content-addressed query hash + auth-independence flag; pluggable cache. *Tier 0: single in-process executor + in-memory cache.* | `UdfExec` · `QueryCache` / `CacheStrategy` · `QueryHash` (content-addressed) |
| 9 | **Multi-region + autoscaling** | Coordinator + load reports + TTL shard map; independent sync/UDF pools | Routing behind `ShardRouter`; load-report + shard-map types reserved. *Tier 0: "Simple" router, no coordinator.* | `ShardRouter` · `SyncShardMap` · `SyncNodeLoadReport` · `SyncTopologyConfig` *(Tier 2)* |
| 10 | **Wire efficiency at fan-out** (10k-row query, 1 row changes) | Swap full-result JSON for a binary delta without a state-model change | Wire encoding is swappable; version brackets already give per-client ack points. *Tier 0: full-snapshot JSON.* | `encodeServerMessage` / `ServerMessage` codec · `StateVersion` ack brackets |

### The three from the mandate, made literal

Strategy fixes three seams as *non-negotiable from day one*. They are rows **1** (shard/namespace
key in the data model → single-writer-per-shard), **3** (connection-sharded sync fleet behind the
sync interface), and **5** (ephemeral broadcast path bypassing the durable log). Rows 2, 4, 6–10
are the supporting seams that make those three reachable. If Foundation ships rows 1/3/5 honestly,
Endpoint B is an exercise in adapters and config; if it fudges any of them, Endpoint B is a
rewrite.

## 4. What must NOT change across the spectrum

The seams are valuable only because of what they protect. Tier 0 → Tier 2 may change **deployment
topology, adapters, and config**. It must **never** change:

- **App code.** `convex/` queries, mutations, schema, indexes — identical.
- **Client code.** `useQuery` / `useMutation` call sites and the typed `api` — identical.
- **The reactive core.** Read-set/write-set intersection as the *one* mechanism for both
  consistency (OCC) and reactivity (subscriptions). The wire may gain binary deltas; the *model*
  (record reads → match writes → recompute → push) is invariant.
- **The storage contract.** Everything persists through the narrow `DocStore` seam; the engine
  never learns whether it is on SQLite or Postgres or a sharded committer.

This is why the seams live in *interfaces*, not in app-visible behavior. The app author writes one
program; we choose where to cut it.

## 5. Foundation's obligations (the cheap Tier 0 implementations that keep each seam open)

Foundation does **not** build the distributed tier. It builds Tier 0 such that every seam above is
*present but trivial*. Concretely, Foundation must:

1. **Thread a `shardId` (default `"default"`) through** `DocStore.write`, the `Transactor`, the
   `TimestampOracle`, `CommitResult`, and `WriteInvalidation` — even though there is one shard.
   (Rows 1–2.)
2. **Carry a shard/partition-key concept in the data model** (a document field the registry/router
   can later hash), so promoting to per-conversation sharding is config, not migration. (Rows 1–2.)
3. **Build the sync handler against abstract `SyncWebSocket` / `SyncUdfExecutor`** with a loopback
   adapter; never import a concrete socket type into reactive logic. (Row 3.)
4. **Route commit invalidations through a `WriteFanout` publisher** (in-memory adapter) rather than
   a direct call into the sync handler, with a **serializable** payload. (Row 4.)
5. **Make `ServerMessage` a versioned, extensible union** and expose an **ephemeral-broadcast
   ingress distinct from `notifyWrites`** on the sync handler. (Row 5.)
6. **Ship the session guardrail controllers** (backpressure/heartbeat/rate-limit/sub-cap) wired in
   (no-op on loopback) and make the client **resync on any version gap**. (Row 6.)
7. **Land the order-preserving `encodeIndexKey`, `(indexKey,_id)` cursors, and `QueryJournal`**,
   proven by exhaustive ordering property tests. (Row 7.)
8. **Keep `UdfExec` stateless and the query cache pluggable** behind a `CacheStrategy` seam with
   content-addressed `QueryHash`. (Row 8.)
9. **Reserve (declare, don't build) `ShardRouter` / `SyncShardMap` / `SyncNodeLoadReport`** so the
   "Simple" Tier 0 router is one implementation of a known interface. (Row 9.)
10. **Isolate the wire encoding behind `encodeServerMessage`/`ServerMessage`** so a binary delta
    codec drops in against the existing version-bracket ack points. (Row 10.)

Each obligation is a small amount of indirection at Tier 0 that converts an otherwise impossible
rewrite into a drop-in at Tier 2. That conversion *is* the Foundation slice's contribution to the
scalability mandate.

---

**See also:** [system-design.md](./system-design.md) (the tiered architecture), [strategy.md](./strategy.md)
(locked divergences + the mandate), [internals/02](./internals/02-transactions-consistency.md)
(OCC + invalidation), [internals/03](./internals/03-reactivity-sync.md) (sync tier + backpressure),
[internals/06](./internals/06-runtimes-topology.md) (embedded runtime + sharding), and the
end-user [scaling blueprint](../../enduser/deploy/scaling.md).
