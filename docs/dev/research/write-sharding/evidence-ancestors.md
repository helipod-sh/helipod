All three ancestors studied in depth. Here is the report.

---

# Prior-Art Code Analysis: How the Ancestors Sharded (or Didn't)

**Sources studied** (clean-room: mechanisms described in my own words, file paths cited, no code copied):
- `.reference/concave-npm/ex/` — compiled dist + `.d.ts` of `@concavejs/*` 0.0.1-alpha.14
- `.reference/lunora/` — full source repo (FSL-1.1-Apache-2.0)
- `.reference/convex-backend/` — **contrary to the README's "sparse, blobless" note, the full Rust source is present** (806 `.rs` files, including `crates/database/src/committer.rs`) — this turned out to be the highest-value find

---

## 1. Concave (`@concavejs/*`) — shards designed on paper, never consumed; "shard" in shipped code means *sync-session* shard

### 1.1 The data-shard seam exists only as an interface — exactly like Stackbase's today

`.reference/concave-npm/ex/core/dist/interfaces/shard-router.d.ts` declares a `ShardRouter<TStub>` with `getShardForDocument(docId) → string` ("consistent hashing for shards"), `getCommitterStub(shardId)`, and rendezvous-hashed `getSyncNodeId(clientId)` for sticky client routing. The companion `interfaces/transactor.d.ts` sketches a two-mode `Transactor` ("Simple Mode: validates and commits directly to DO SQLite; Distributed Mode: sends to Committer DO for validation + D1 commit") whose `OplogDelta` carries an optional `shard_id`, and `interfaces/change-stream-consumer.d.ts` mirrors it with a `ChangeDelta.shard_id` plus a `getCurrentPosition(): bigint` cursor.

**None of it shipped.** The corresponding `.js` for shard-router exports nothing but the type (`interfaces/shard-router.js` is an empty `export {}`), and a grep of the entire Cloudflare runtime bundle (`cli/dist/assets/runtime-cf/runtime.bundle.js`, 64k lines) finds **zero** occurrences of `getShardForDocument`, `getCommitterStub`, or any Committer DO class. Concave died with the same typed-but-unconsumed shard seam Stackbase has now. The document-granularity routing (`getShardForDocument` takes a *document id*, not a shard-key field) is also notable: they were contemplating hash-per-document sharding, which would have made single-shard OCC transactions almost impossible — a mutation touching 3 documents would span 3 shards. Lunora's field-value sharding (below) is the correction.

### 1.2 What concave actually sharded: WebSocket sync sessions, with autoscale

All the real `shard*` machinery in the shipped bundle is **sync-node pooling**: `runtime-base/dist/sync/sync-topology.d.ts` defines a `SyncShardMap` (`regions → [syncDoNames]`, `notifyShards`, TTL), load reports per sync shard (`activeSessions`, `messageRatePerSecond`, `notifyRatePerSecond`, CPU/memory), and a full autoscale controller (cooldowns, hysteresis, step limits, scale-to-zero). A `SyncCoordinatorDO` (`runtime.bundle.js` line ~63332) collects `POST /report-load` from sync DOs, computes the shard map, persists it in DO storage, and publishes it to KV for cache. This is a *coordinator DO for stateless session capacity*, not for data — the data tier stayed singular.

### 1.3 Topology: one `ConcaveDOBase` per logical instance = the whole database

`ConcaveDOBase` (bundle line ~50512) is one Durable Object holding the docstore, blobstore, search/vector stores, the UDF executor, the scheduler, and cron state for an entire app instance (`state.id.name` = instance id). Commit → `SyncNotifier.notify` posts `{writtenRanges, writtenTables, commitTimestamp}` to the instance's sync DO(s); the multi-sync-shard variant (`ConfigurableConcaveDO.notifySyncDo`, ~63292) fans the same notify to every sync shard from the shard map. Sync DOs re-run subscribed queries by RPC back to the instance DO (or D1) via `CloudflareSyncUdfExecutor` (~63476). **Invalidation is push-notify with ranges + a commit ts; there is no log-tailing replica anywhere** — so concave never needed a "stable prefix" property and never built one.

### 1.4 Timestamps: a per-instance HLC with an *unwired* cross-instance merge hook

`core/dist/utils/timestamp.js`: `allocateTimestamp()` = take `max(logicalClock, wallClockMs)`, bump by 1 if the wall clock hasn't advanced — a classic hybrid-logical clock at **millisecond** granularity, one oracle per docstore instance ("Each Durable Object should have its own oracle to ensure isolation"). `observeTimestamp(ts)` exists to merge externally-observed timestamps, and `docstore-sqlite-base/dist/base.js` calls it on every row it reads/writes (lines 192, 327, 369, …) so an oracle rehydrates from data it encounters. But nothing ever feeds one writer's allocations to another *before* commit — monotonicity is only per-observer, only eventual.

### 1.5 The multi-writer hole they shipped and dodged

The CF runtime has a "direct runtime" mode (`getOrCreateSharedDirectRuntime`, ~33620): when the manifest says `storage.docstore === "d1"`, **queries AND mutations can execute "inline-local" inside any sync DO or worker isolate, directly against shared D1** (`resolveDefaultPlacement`, ~33961: with direct storage and no isolated UDF worker, all three function types go `inline-local`). That is N concurrent writers on one shared database with:

- OCC validation that re-reads current versions from the store (`transactor/occ-validation.d.ts`: `validateReadSetForCommit(docstore, readChecks, writtenDocKeys)`) and *then* applies the write batch — **validate and write are two separate D1 round trips, not atomic together**. Two concurrent committers can both validate against the same snapshot and both batch-write. D1's `batch()` is atomic *per batch* (`D1SqliteAdapter.transaction` collects statements and flushes one batch to the primary session, ~33068), but nothing serializes validate→write across writers.
- Per-writer HLC oracles seeded from `Date.now()` ms — two isolates can allocate the **same** timestamp for different commits, and commits land out of order relative to their ts values.

The saving grace was §1.3: because invalidation is push-notify and reads re-execute at "latest", nothing *consumed* a global-prefix invariant, so the disorder was mostly invisible — it would have surfaced as OCC misses (lost-update windows) under real write contention. Concave dodged problem #1 by never building the reader that depends on it, at the cost of a correctness hole in their multi-writer path.

One genuinely reusable mechanism: **D1 Sessions bookmarks for read-your-writes on read replicas** (`D1SqliteAdapter.getBookmark`/`captureWriteBookmark`, ~33083): after a write, capture the session bookmark; subsequent reads open a session constrained to at-least-that-bookmark. It's a per-causal-chain watermark rather than a global one — an existence proof that RYOW does not require a global stable prefix.

---

## 2. Lunora — the closest shipped answer: shard = an explicitly-addressed, fully independent consistency domain

Lunora ("Convex DX on your own Cloudflare account") is the only ancestor that shipped write sharding end-to-end. Its answer to both hard problems is radical: **there is no cross-shard timestamp line at all.**

### 2.1 The `.shardBy(field)` API (schema-level, table-granular)

`packages/server/src/schema.ts` (line ~350): a fluent `defineTable({...}).shardBy("channelId")` sets `shardMode = { kind: "shardBy", field }`; the other modes are `root` (default — everything lives in one `__root__` DO) and `global` (D1/Hyperdrive-backed, cross-shard). Docs (`apps/docs/src/content/docs/concepts/sharding.mdx`): "Sharding is a single edit … A chat with 5 000 active channels now spreads across 5 000 DOs, each with its own SQLite, CPU budget, and hibernation timer." A size warning fires at 1 GiB (10% of the 10 GiB DO ceiling) telling you to plan the migration — scaling is *reactive to a wall*, not transparent.

**Placement is by address, not by field-value enforcement**: the shard key IS the Durable Object name (`ShardDO.currentShardKey()` = `state.id.name`, `packages/do/src/shard-do.ts` ~3929). I found no write-path guard that a row's `shardBy` field value matches the hosting DO — the routing is a *convention* the envelope enforces, so a mutation sent to shard A can physically store a `channelId=B` row in A's SQLite and it will simply never be found by B-routed reads.

### 2.2 Mutation-routing DX: the client names the shard, explicitly, per call

The RPC envelope (`packages/runtime/src/create-worker.ts` ~36-47) carries an optional `shardKey`; omitted → the default/root shard; `fanOut: {table}` is mutually exclusive with `shardKey` ("fan-out *is* the shard choice"). On the client, `shardKey` is an **explicit per-call option**: `client.query(fn, args, { shardKey })`, `useQuery`'s options, mutation options (`packages/react/src/query-options.ts` ~44-51, `packages/react/src/types.ts`). The React query key is the `(fn, args, shardKey)` triple. **Codegen does NOT derive the shard key from args** — no example app even exercises it (grep across `examples/` finds `shardKey` only in generated OpenAPI). The docs' "after codegen, every call to `ctx.db.messages.*` routes by `channelId`" refers to server-side scoping *inside* the DO the envelope already picked, plus the fan-out path.

Because the client picks the address, **the shard key becomes a security surface**: `sharding.mdx` §"Securing shard access" — default-deny (403 `FORBIDDEN_SHARD`/`FORBIDDEN_FANOUT`) for any non-default shard, with an `authorizeShard(identity, shardKey)` callback on `createWorker` (e.g. `identity?.userId === shardKey`) and a separate, more-privileged `authorizeFanOut`. The alternative (`allowUnauthenticatedShardAccess: true`) is only sanctioned when every table has RLS. This is a real DX/safety tax that a server-side-resolved `shardBy(args)` design would not pay.

Transport: **one WebSocket per shard key** (`packages/client/src/lunora-client.ts` ~261: "Subscriptions and the writes they observe must land on the same Durable Object, so each distinct `shardKey` gets its own socket connected to `?shard=<key>`"). Connection state, backoff, outbox, and context are all per-shard; one shard dropping doesn't disturb the others.

### 2.3 Per-shard logs and versioning — how they "solved" problem #1 by never having it

Each `ShardDO` has:
- an append-only **`__cdc_log`** with an SQLite `AUTOINCREMENT` `seq` primary key — "a monotonic **per-shard** cursor — strictly increasing, never reused" (`packages/do/src/ctx-db-cdc.ts` ~22-56), written **in the same DO transaction as the row write**;
- a single-row **`__cdc_meta` epoch** (a UUID) minted per timeline and bumped whenever the log is reset — "a client holding an old high `sinceSeq` would be told 'resumable' against the new, unrelated timeline … a subscriber resumes only when BOTH the epoch matches and the cursor is in range" (~160-210);
- a per-`(identity, clientId)` **`__client_watermark`** — highest applied client mutation id, advanced *after* the handler's writes commit (not atomically; the gap self-heals because replay is idempotent via a separate `__idempotency` row, and the upsert is `MAX()`-monotonic) (`ctx-db-client-watermark.ts`, whole file). Dispatch contract: `id <= watermark` → skip/ack; `== watermark+1` → run; `> watermark+1` → halt, client resends from the gap.

Poke frames stamp `{checkpoint (cdc seq), baseCheckpoint, epoch, lastMutationId, pokeId}` (`shape-global-diff.ts` `PokeFrameMeta`; `shard-do.ts` ~6456, ~7022). A reconnecting client resumes per-shard with `(epoch, sinceSeq)`; epoch mismatch, checkpoint ahead of the shard, or seq older than retention → forced full re-seed ("the DO refuses to guess", `architecture.mdx` failure-modes list).

**The client therefore holds N independent `(epoch, cursor)` pairs — there is no cross-shard version, no cross-shard snapshot, no ordering relation between two shards' timelines, ever.** Reactivity within a shard is row-id + `*scan`-marker dependency tracking (`dependency-tracker.ts`: dep key = `table:id`, any non-indexed read degrades to a per-table scan marker) — coarser than Stackbase's index-range read-sets.

### 2.4 Cross-shard READS: one-shot fan-out only — the reactive case is explicitly downgraded

The **Query Coordinator** (`packages/runtime/src/query-coordinator.ts`) fans a read out to every live shard key (from a `ShardRegistry`), bounded by `maxConcurrency`, with a per-shard timeout, and merges with **wire-serializable strategies only**: `concat`, `topK` (field name, not closure), `first`, `sum`, `max`, `min`, `groupBy`, `rank` (sums per-shard `{before,total}` into a global position). `avg` is deliberately rejected in v1 with an instructive error ("a correct cross-shard average requires shipping `(sum,count)` per shard, not the post-shard mean"). Shard-key discovery: a single `ShardRegistryDO` holding `Map<table, Set<shardKey>>`, registered on first write via `ctx.waitUntil` (off the write's latency path), client-cached with a ~30 s TTL — "the TTL is the eventual-consistency bound: a newly registered shard key takes up to cacheTtlMs to participate in a fan-out" (`dynamic-shard-registry.ts` ~28-37, `shard-registry-do.ts` header).

Consistency of a fan-out: **none across shards** — it's a merge of N independent local snapshots taken at N different moments. Nothing in the codebase versions a fan-out result.

**Cross-shard reactive subscriptions do not exist.** Grep for `fanOut` in `packages/client/src/subscription.ts`/`lunora-client.ts`: zero hits — fan-out is request/response only. The sanctioned path for "live query spanning shards" is to *move the table* to `.global()` (D1), and the docs are candid about the price: "The price of `.global()` is the live-sync downgrade: a `.global()`-backed shape reads from D1 and is coordinator/poll-refreshed (latency-tiered), **not** poke-live — D1 has no per-DO op-log to diff" (`architecture.mdx` ~214). Mechanically (`shape-global-diff.ts` header): each alarm tick re-reads the full membership from D1 and diffs it against a per-socket snapshot of what was last poked (`id → projected-value JSON`) — brute-force poll-and-diff per subscriber, no read-set intersection at all. D1 RYOW comes from threading the Sessions bookmark (`x-d1-bookmark`, `@lunora/d1`'s `D1Session`), and cross-replica convergence is acknowledged as lag-bounded (`architecture.mdx` ~345).

Cross-**backend** relations got a genuinely clever hack (`runtime/src/cross-shard-relations.ts`): a global (D1) parent loading shard-local children issues a *loopback* `fanOut` RPC through the worker's own public endpoint — reusing identity resolution and the `authorizeFanOut` gate — with an explicit RE-ENTRANCY warning that the host shard and the child shards must be distinct DOs or the fan-out deadlocks the host's input gate. That warning is a preview of the hazards any "query executes on one shard but reads another" design inherits.

### 2.5 What D1 "global" tables were for

Identities, billing, cross-tenant audit logs — low-write-rate, must-span-shards data (`sharding.mdx` §"Going global"; `architecture.mdx` Tier 2). They also carry their own D1-side CDC log for the offline-sync feed (`runD1CdcMigration`/`readD1CdcChanges` in `@lunora/d1`), separate from the reactive (poll-diff) path.

### 2.6 Lunora's documented limitations (their own words, paraphrased)

- Per-DO ceiling 10 GB / ~1 000 req/s; warning at 10%; migration is on you (`sharding.mdx`, `architecture.mdx` "Hot shard").
- Fan-out in hot paths: "Avoid this" (`sharding.mdx` §Cross-shard reads).
- `.global()` = reactivity downgrade + replica lag (above).
- No cross-shard transactions of any kind — not even discussed; a mutation executes on exactly one DO.
- Fallen-behind subscriber → full re-seed; mid-poke disconnect → re-seed (atomic-at-`pokeEnd`).
- Single `ShardRegistryDO` "sufficient up to tens of thousands of distinct shard keys" — an acknowledged scaling stop.

---

## 3. Convex backend — no sharding, but the definitive single-writer timestamp protocol (full Rust source present)

Convex never shards data (grep for shard across 69 crates: only incidental hits in `knobs.rs`/`index_cache`). Its open-source backend is one **single-threaded Committer** per deployment (`crates/database/src/committer.rs`) — but that committer solves, *within one writer*, exactly the safe-visibility problem Stackbase faces across writers, and the mechanism generalizes.

### 3.1 Commit-ts allocation

`next_commit_ts` (~1165): `max(latest_published_ts + 1, wall_clock_generated_ts, last_assigned_ts + 1)` — an HLC bound below by everything already visible and by everything this committer has already handed out. Single-threaded, so allocation order = processing order.

### 3.2 The pipelined commit + the `max_repeatable_ts` watermark — the crown jewel

The committer *pipelines* persistence writes (a `FuturesOrdered` queue, published strictly in completion order) so multiple commits are in flight at once. Readers other than the leader must not trust any ts they see in the log, because a *smaller* ts may still be in flight — precisely Stackbase's problem #1, in miniature. Convex's answer:

- `next_max_repeatable_ts` (~1179): **if there are pending (in-flight) writes, the safe watermark is `min(pending) − 1`** — the largest ts guaranteed to be a stable prefix; if idle, allocate a fresh ts (which also fences future commits above it).
- `bump_max_repeatable_ts` (~634): periodically (after commits, with an idle-frequency floor and randomized jitter; bumps never run in parallel "in case they commit out of order and regress the repeatable timestamp", `go()` loop ~255-292) the committer **persists** this watermark as a `PersistenceGlobalKey::MaxRepeatableTimestamp` row in the same database, retrying with backoff forever (blocking further progress rather than regressing).
- The comment at ~651 states the dual purpose: "ensures all future commits on **future leaders** will be after new_max_repeatable, and **followers** can know this timestamp is repeatable." I.e. the same persisted watermark is both the failover fence (a new leader boots above it) and the replica-visibility frontier.
- Followers establish snapshots via `new_static_repeatable_recent(reader)` (`crates/common/src/persistence.rs` ~724): read the persistence global, get a `RepeatableTimestamp`.
- `RepeatableTimestamp` is a **provenance-typed wrapper** (`crates/common/src/types/timestamp.rs`): constructors must prove *why* a ts is repeatable (enumerated `RepeatableReason`s — from the persistence global, from the snapshot manager, inductively ≤ another repeatable ts, …). Type-level enforcement that no reader ever treats a raw log ts as a snapshot boundary.

### 3.3 OCC details worth stealing

`validate_commit` (~716): allocate `commit_ts`, check the read set against BOTH the published write log (`log.is_stale`) and the **pending (not yet persisted) writes** (`pending_writes.is_stale`) over `(begin_ts, commit_ts]` — this is what makes pipelining safe. Validated writes are appended to `pending_writes` *before* persistence, so later transactions conflict against them immediately; the comment explicitly accepts "theoretical false conflicts" from a pending commit that later fails — false positives by design. A transaction whose reads are clean is thereby *rebased* onto the new commit_ts without re-execution. Also: `write_to_persistence`'s doc comment — if the process is unsure whether a persistence write landed, it **crashes and recovers from persistence** rather than guessing; recovery order is unambiguous because publish order = ts order.

---

## What the ancestors prove, what they dodged, and the traps to avoid

### Proven

1. **"Shard = explicitly-keyed independent consistency domain" ships and feels fine for the single-shard hot path** (lunora). One writer + one log + one `(epoch, cursor)` per shard; the client multiplexes N independent streams. Nothing about problem #1 needs solving *within* a shard.
2. **A persisted safe-visibility watermark decoupled from commit order works and is cheap** (convex). `max_repeatable = min(in-flight) − 1`, persisted lazily/periodically in the *same database* (no extra infra), doubling as the leader-failover fence. This is the single most important mechanism in all three codebases for Stackbase's problem #1: generalize it from "one committer's pipeline" to "N shard-writers' pipelines" — a per-shard or vector/min-aggregated watermark gives replicas a stable prefix without per-commit coordination. Convex also proves the hygiene that makes it robust: watermark bumps never regress and never run concurrently; a *type-level* `RepeatableTimestamp` (provenance-checked) prevents any reader from accidentally trusting a raw ts.
3. **Wire-serializable merge strategies make cross-shard one-shot reads tractable and honest** (lunora): concat/topK/sum/min/max/groupBy/rank, with `avg` rejected loudly. A registry-DO + TTL cache is enough shard discovery for tens of thousands of keys.
4. **Read-your-writes needs only a causal token, not a global prefix** (concave's D1 bookmarks, lunora's `x-d1-bookmark`, and Stackbase's own commitTs-wait): a per-client "at least this far" watermark per shard suffices.
5. **Timeline identity (epoch) must be paired with any cursor** (lunora `__cdc_meta`): a per-shard log that can be reset/failovered needs an epoch UUID or clients resume onto forked timelines. Stackbase's fleet has one lease-protected timeline today; per-shard leases multiply the failover surface, and this is the proven antidote.

### Dodged

1. **Nobody kept a cross-shard reactive query working. Nobody.** Concave never sharded data. Convex never sharded at all. Lunora — the only shipped sharding — supports live subscriptions strictly per-shard; a query spanning shards is either a one-shot fan-out or a `.global()` table whose "reactivity" is per-socket poll-and-full-diff each alarm tick, documented as a downgrade. **Stackbase's brief (cross-shard subscriptions must keep working, with real invalidation) is beyond all prior art in this lineage** — the read-set/range-intersection machinery Stackbase already has is precisely what lunora lacked, and range-precise invalidation against N per-shard logs (subscription re-runs when *any* owning shard's write range intersects) is the natural extension none of them built.
2. **Mutation-routing DX was answered by nobody the way Stackbase wants.** Lunora's answer — client-supplied `shardKey` per call, one socket per shard, default-deny + `authorizeShard` — works but leaks the topology into app code and turns the shard key into an attack surface. Concave's interface answer (`getShardForDocument`, hash-per-document) was never consumed and is arguably wrong-grained (per-document hashing breaks single-shard transactionality). A server-side `mutation({shardBy})` that resolves the shard from *args before execution* — routing via the existing `/_fleet/run` forwarding, invisible at Tier 0 — has no precedent in the ancestors; the nearest analogue is lunora's *schema-level* `.shardBy(field)` which proves the "single edit, table-granular" ergonomics.
3. **Concave dodged multi-writer correctness** by (a) never wiring `observeTimestamp` across writers and (b) shipping a validate-then-batch D1 path with no atomicity across the two phases. It got away with it only because no shipped reader depended on a stable prefix.
4. **Lunora dodged cross-shard consistency entirely** — no version relates two shards; a fan-out is a merge of unrelated snapshots. Fine for `count`, silently wrong for anything reading an invariant that spans shards. It never claims otherwise, but it also never surfaces the anomaly to the developer.

### Traps to avoid

1. **Wall-clock-seeded HLCs at ms granularity as commit timestamps across writers** (concave): duplicate ts across writers, ordering inversions, and an `observeTimestamp`-style merge hook that exists but is never actually fed. If shards keep the global bigint ts line, allocation must be fenced (Convex-style: each shard's writer allocates above a persisted floor), and *visibility* must come from a watermark protocol — never from "I saw ts X, so everything ≤ X is here." Stackbase's replica watermark assumption is exactly the reader concave never built and would have broken.
2. **Validate-and-write as two non-atomic phases against shared storage** (concave's D1 inline mutations). Per-shard OCC must stay in-process with a single writer per shard (Stackbase's advisory-lease-per-shard extension of the fleet design), or validation is fiction.
3. **Client-chosen shard addresses without a mandatory authorization story** (lunora had to bolt on default-deny + `authorizeShard` + a one-time security warning). If the server resolves the shard from mutation args, this whole class disappears — one more argument for `shardBy` resolving server-side.
4. **Poll-and-diff as the cross-shard reactivity fallback** (lunora's `.global()` shapes): per-socket full-membership re-reads per tick is O(subscribers × table size) and latency-tiered. Stackbase's range-intersection invalidation over per-shard logs can do strictly better; don't accept the downgrade as inevitable.
5. **Watermark bumps that can race or regress**: Convex explicitly serializes bumps ("avoid parallel bumps in case they commit out of order and regress the repeatable timestamp") and blocks forward progress rather than skip a failed bump. Any per-shard watermark aggregation (e.g. a global visible-ts = min over shards) inherits this: one stalled shard must degrade *staleness*, never *correctness* — and needs an idle-bump (Convex's `MAX_REPEATABLE_TIMESTAMP_IDLE_FREQUENCY`) so an idle shard doesn't pin the fleet's frontier forever.
6. **Per-document/hash sharding granularity** (concave's `getShardForDocument`): kills single-shard transactions. Lunora's field-value granularity (and Stackbase's locked "conversation = shard") is the right unit; the schema seam (`.shardKey(field)`) already matches it.
7. **Forgetting timeline identity on resumable per-shard logs** (lunora's epoch exists precisely because AUTOINCREMENT cursors restart after a reset): with per-shard leases and failover, pair every per-shard cursor with an epoch/lease-generation, or a failed-over shard serves forked history to resuming replicas/clients.
8. **Registry as an afterthought**: lunora's single registry DO + 30 s TTL cache is fine for fan-out *reads* but its eventual consistency window would be a correctness bug if reused for *write* routing or watermark aggregation. Shard discovery for writes needs the same authority as the lease itself (Stackbase's `fleet_lease` row pattern — the store as its own coordinator — extends naturally to a `shard_lease` table; that is also `tier2-topology-research.md`'s locked "no coordinator service" constraint, which all three ancestors independently validate: concave's coordinator DO was for session capacity only, lunora's registry is advisory, convex has no coordinator at all).

**Bottom line**: the lineage proves the two halves separately — lunora proves the *sharding shape* (field-keyed independent write domains, per-shard logs, explicit-but-clunky routing, honest fan-out merges) and Convex proves the *visibility protocol* (in-flight-aware persisted watermark + provenance-typed repeatable timestamps + fenced allocation). Neither combined them, and neither kept reactive queries alive across the shard boundary. Combining Convex's watermark protocol (per shard, min-aggregated for cross-shard snapshot reads) with Stackbase's existing range-intersection invalidation over verbatim per-shard log tailing — behind a server-resolved `mutation({shardBy})` that is a no-op at Tier 0 — would be genuinely novel relative to every ancestor studied.