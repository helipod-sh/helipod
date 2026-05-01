# Slice 6 — Multi-shard + the cross-shard query/index layer: design spec

**Date:** 2026-03-20
**Status:** DESIGN SPEC + RESEARCH (no engine code changed). The program's biggest risk, deferred until
the single-shard DO host (Slice 3) is proven. Turns into a `superpowers:writing-plans` TDD plan only
after the human decisions in §6.3 are answered.
**Branch:** `slice6-crossshard-spec`, from `spike/cloudflare-r2-gate`.
**Scope:** Slice 6 of `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:174-191` —
`.shardBy(key)` → one transactor-DO per shard (write scale-out past the single-DO ~200–500 writes/s
ceiling AND past the 10 GB/DO storage ceiling), PLUS the cross-shard query and global-index story.

**Reads this builds on:**
- Roadmap Slice 6 (`…/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:174-191`) + Global
  Constraints (`:25-42`).
- Research: the four named engine changes, change #4 = "R2-single-truth → per-DO sharded storage + a
  cross-shard query/index layer … genuinely new engine surface"
  (`docs/dev/research/cloudflare-do-native-host.md:42-47`, `:86-91`).
- **Slice 3 spec** (`docs/superpowers/specs/2026-03-20-do-host-slice3-design.md`) — its §2.3
  *forward-designed the Slice-6 RPC seam*: it kept `notifyWrites(invalidation)` a single named method
  carrying `origin` + commit `ts` "so Slice 6 can later make that method an RPC without touching the
  engine" (`:112-114`, `:182-190`). **This spec honors and consumes that seam.**
- Our shipped multi-shard machinery: `packages/transactor/src/sharded-transactor.ts`,
  `ee/packages/objectstore-substrate/src/{sharded-object-doc-store.ts,reshard.ts}`,
  `ee/packages/fleet/src/{node.ts,replica-tailer.ts}`, `packages/sync/src/handler.ts`.
- References (studied, never copied — FSL-1.1): Lunora `.shardBy()`/`.global()`/D1-Sessions/Query-
  Coordinator (`.reference/lunora/packages/{server,runtime,do,d1,sql-store}/`), Concave's sync-shard
  scaling blueprint (`.reference/concave-docs-raw/llms-full.txt:1420-1565`).
- Cloudflare docs (cloudflare-docs MCP, this session): DO-to-DO RPC + billing, D1 Sessions API
  read-replication + `withSession`/bookmark, D1 size limits.

---

## TL;DR — the load-bearing findings, up front

1. **Honest one-line verdict: v1 is BUILDABLE BEHIND THE SEAMS — as a deliberately *reduced* scope that
   matches the strongest reference (Lunora) almost exactly — with a named D1 dependency for the
   genuinely-global capabilities.** A faithful port of our portable path's "cross-shard-query-is-free" is
   NOT buildable on DO, and pretending otherwise is the trap. General cross-shard *reactive* query and
   cross-shard global-unique are the parts that need either a documented **non-goal** or **D1**. See §0
   for why, §6 for the exact cut.

2. **"Cross-shard query already works on our portable path" is TRUE but MISLEADING for DO** (§0). It
   works there because sharding is *only at the transactor tier* — the **storage tier and the sync tier
   stay GLOBAL and single-process**: one shared log table (embedded/D1) or an in-process
   scatter-gather-merge over lanes (`ShardedObjectStoreDocStore`, `sharded-object-doc-store.ts:14-20`),
   fed by ONE `SubscriptionManager` (`packages/sync/src/handler.ts:228`). **DO write-sharding
   structurally forbids a single global store or a single global subscription registry** — that is the
   *whole point* of splitting into separate objects (past the single-thread + 10 GB limits). So Slice 6
   ports the *mechanism* but not its *cost model* and not its *synchronous ordering guarantee* (the
   `onCommitted` cross-oracle fan-out is an in-process call that cannot be synchronous across DOs, §0.2).

3. **The proven reference (Lunora) matches this conclusion almost verbatim — copy its shape.** A Lunora
   table is exactly one of three modes: `root` (default single DO), `shardBy` (partitioned across many
   DOs by user/tenant/room), or `global` (lives in **D1**, real column-per-field schema, `.unique()`
   enforced by D1's own SQLite) — `.reference/lunora/packages/server/src/types.ts:16,28`;
   `schema.ts:242,281-283,350-352`. Critically:
   - **Cross-shard *reactivity* is made IMPOSSIBLE, not propagated.** A live query that joins across
     `.shardBy` tables is **rejected** (`SHAPE_CROSS_SHARD_JOIN`, HTTP 400,
     `.reference/lunora/packages/do/src/relation-predicates.ts:531,567-569`). `.global()` live queries
     are **not poke-live — they POLL D1 on a coarse alarm** (seconds-floor latency,
     `.reference/lunora/packages/do/src/shard-do.ts:1416-1421,2388-2436`).
   - **Cross-shard *non-reactive read* IS offered — as an opt-in scatter-gather** ("Query Coordinator":
     bounded-concurrency fan-out to live shards + a wire-serializable merge, failures returned as data,
     `.reference/lunora/packages/runtime/src/query-coordinator.ts:1-21,74-82`), gated by an explicit
     `fanOut` flag + authz, **never on the reactive path**.
   - **Global-unique = put the table in `.global()` (D1); a `.unique()` on a `.shardBy` table holds only
     within one shard** (`ctx-db.ts:1040-1049`); there is no cross-shard uniqueness authority.
   - **There is NO online reshard** — only a `hot_shard` advisor lint that tells you to re-shard
     manually (`.reference/lunora/packages/advisor/src/lints/runtime/hot-shard.ts:23-48`).

4. **Recommended v1 (§6): `.shardBy(key)` with shard-SCOPED reactive queries + `.global()`/D1 for global
   reads & global-unique + an opt-in NON-REACTIVE cross-shard fan-out read.** No reactive cross-shard
   query; no cross-`.shardBy` global-unique. This matches Lunora's shipped reality, the DynamoDB
   partition model, and the physical reality DO forces — and it **defers the hardest correctness
   problem** (distributed cross-shard invalidation, §3) because a shard-scoped reactive subscription
   lives on exactly ONE DO, so Slice 3's in-process G1/G4 proof carries over unchanged.

5. **Routing is nearly free on DO and largely dissolves reshard.** CF's `namespace.getByName(shardKey)`
   gives a globally-unique DO per name with **no shard map, no coordinator**
   (`resolve-shard.ts:64-73`; CF `getByName` changelog 2025-08-21). One-DO-per-shard-key (room/tenant)
   means **you never grow N and never reshard** — a new key just addresses a new DO. Lunora routes this
   way and ships no reshard at all.

6. **The Slice-3 seam is exactly the extension point, as designed.** `notifyWrites(inv, origin)` becomes
   the (optional, `.global()`-only) cross-DO notify; the `.shardBy` shard-scoped path needs **no engine
   change** (each shard-DO is an independent Slice-3 host). All cloudflare/D1 types live in
   `runtime-cloudflare` + the D1 adapter package, never in the engine (Global Constraints `:27`).

---

## 0. The reframing that governs everything: three meanings of "shard"

This section is the spine. Get it wrong and the spec designs a distributed database nobody asked for.

### 0.1 "Cross-shard query works today" — where, and *why* it works

Our shipped multi-shard path (`ShardedTransactor`) makes cross-shard query and cross-shard invalidation
Just Work. That is real. But the *reason* they work does not survive the move to DO:

| Tier | What "shard" is | Storage | Sync/subscription tier | Cross-shard query | Cross-shard invalidation |
|---|---|---|---|---|---|
| **ShardedTransactor** (portable Tier 0/2) | a **logical write-concurrency lane**: per-shard mutex + OCC ring + oracle (`sharded-transactor.ts:1-11`) | **ONE shared physical DocStore / log table** (`sharded-transactor.ts:24,28-29`) | **ONE global `SubscriptionManager`** fed by ONE fan-out (`handler.ts:228`; `sharded-transactor.ts:180`) | **FREE** — a query is *never routed* (`sharded-transactor.ts:83,88-94`); reads the whole store at the `"default"` oracle snapshot | **FREE** — single shard-agnostic registry; range∩range has no shard dimension (`subscription-manager.ts:96-115`) |
| **objectstore-substrate** (portable Tier 3) | a **physically independent lane log** (`s{shard}/…`) | **N physical logs, composed behind ONE DocStore IN-PROCESS** (`sharded-object-doc-store.ts:2-12`) | still ONE global `SubscriptionManager`, in-process | **scatter-gather-MERGE across lanes, in one process** (`mergeSortedAsyncGenerators`, `sharded-object-doc-store.ts:151-192`) | still free (one registry) |
| **DO-native** (Slice 6) | **a separate Durable Object**, its own DO-SQLite, its own isolate/machine | **N physically isolated DO-SQLite DBs, NO shared process** | **CANNOT be one global in-process registry** — that recentralizes onto one object and defeats sharding | **N DO-to-DO RPCs** (each a wake + cross-object hop + billed request) | **crosses a real DO/RPC boundary** — the hard problem |

The load-bearing fact: **on both portable tiers, what makes cross-shard cheap is that ONE process holds
all the data (or all the lanes) and ONE registry holds all the subscriptions.** DO write-sharding exists
*specifically to break that* — to get past the single-thread ~200–500 writes/s ceiling
(`cloudflare-do-native-host.md:22,30-33`) and the 10 GB/DO ceiling (`:18`). You cannot keep a single
global store or registry and still scale writes; the two goals are mutually exclusive on DO.

Corollary (the trap): a single-writer DO owning *all* data in one DO-SQLite would give free cross-shard
query — but that is **Concave's model** (`ConcaveDO` singleton + sharded *sync* tier,
`llms-full.txt:1523-1537`), which is exactly what **Slice 3 already is** (one writer-DO, sync-split
deferred). Concave shards the *sync/fan-out* tier, never the *writer* — so it does NOT scale writes past
one DO and is not a Slice-6 answer. Write-sharding on DO **necessarily** means physically-separate
writer-DOs, which **necessarily** loses free cross-shard query. Do not let a reviewer conflate the two.

### 0.2 The `onCommitted` synchronous ordering guarantee does not cross the DO boundary

The portable path's cross-shard *correctness* rests on one mechanism: `ShardWriter.commit` calls
`onCommitted(commitTs)` **synchronously, after its own `oracle.publishCommitted` but BEFORE
`fanout.publish` makes the commit observable** (`shard-writer.ts:411,421,436-438`), fanning `ts` to
*every sibling shard's oracle* in the same object (`sharded-transactor.ts:120-123,184-193`). This is the
shipped **D12 fix** — without it "the confirming cross-shard Transition carried a stale (write-absent)
QueryUpdated and — absent foreign traffic — stayed stale forever" (`sharded-transactor.ts:189-191`), the
one-frame-flicker class the roadmap warns Slice 6 will re-encounter.

**On DO, sibling shards are separate objects.** You cannot synchronously advance another DO's oracle
before your own fan-out publishes; a cross-DO call is an async RPC with its own wake. So *any* design
that lets one query's snapshot span multiple shard-DOs re-opens D12 as a genuine distributed ordering
problem. **The v1 recommendation avoids this entirely by never letting a `.shardBy` reactive
subscription span shards** (§3) — the same conclusion Lunora reached and enforced with a hard 400
(`relation-predicates.ts:531`). A future "true cross-shard reactive query" must solve it as a distributed
frontier problem; the fleet's `ReplicaTailer` `F = min(frontier_ts)` dense-prefix
(`replica-tailer.ts:24-26,44-46`) is the precedent to port, at real cross-DO cost.

### 0.3 The honest delta: what `.shardBy` *means* diverges between the two hosts

Same app code, both paths — but `.shardBy` does not mean the same thing:

- **Portable `.shardBy(key)`:** pure write-concurrency. A cross-shard query still reads everything, free
  and reactive.
- **DO `.shardBy(key)`:** a physical partition. A *reactive* cross-shard query over sharded tables is
  **not offered** (use `.global()`); a *non-reactive* one is an opt-in fan-out.

An app that (a) uses `.shardBy` **and** (b) issues a *reactive* query reading across shard keys works on
the container path and would **not** work the same on DO v1. This is a real, load-bearing semantic
divergence and belongs in front of the user (human decision 2, §6.3). It does **not** break "same app
code" for the *common* case — the **default is a single unsharded DO** (one shard = full reactive query,
byte-identical to portable single-node), and `.shardBy` is **opt-in**, exactly as on the portable path
(`runtime-embedded/src/runtime.ts:437-445` builds `ShardedTransactor` only when `numShards > 1`). The
divergence bites only when you opt into `.shardBy` *and* need a cross-key reactive query — and the honest
answer is `.global()`/D1, the CF-idiomatic tool the portable path lacks.

---

## 1. Sharding key + routing

### 1.1 The reference: `getByName(shardKey)` — the DO namespace IS the shard map

Lunora routes a sharded request with `resolveShard(namespace, shardKey)` →
`namespace.getByName(shardKey)` (with an `idFromName(shardKey)+get` fallback) (`resolve-shard.ts:64-73`).
CF confirms `getByName` returns a stub to "a globally-unique name … from anywhere in the world" with no
intermediate ID step (CF changelog 2025-08-21). **There is no shard-map cache, no coordinator DO, no
rendezvous hash to publish** — the platform's `idFromName` *is* the consistent name→object mapping.
(Contrast Concave's blueprint, which runs a coordinator DO + KV shard-map — but that is for its *sync*
shard pool autoscaling, `llms-full.txt:1533-1548`, not data-key write routing.)

For discovering the *set* of live shards (needed only for fan-out / admin), Lunora keeps a single
`ShardRegistryDO` holding `Map<table, Set<shardKey>>`, written on first-seen key and read with a ~30s
cache (`.reference/lunora/packages/do/src/shard-registry-do.ts:1-33`;
`.reference/lunora/packages/runtime/src/dynamic-shard-registry.ts:49-57`). It tracks membership only — it
does not move data.

Two routing variants — **human decision 1 (§6.3):**
- **(A) One DO per distinct shard-key value** — `getByName(canonicalize(shardKey))`. Unbounded DOs (CF
  supports "billions"). Natural for `.shardBy` "by user/tenant/room". **No fixed N, no reshard, no shard
  map.** Perfect isolation. This is Lunora's model. Cost: a "read all keys" query must enumerate live
  shards via the registry — reinforcing that *shard-scoped* is the blessed path.
- **(B) Fixed-N hash** — `getByName("s" + shardIdForKeyValue(shardKey, N))`, reusing our shipped
  jump-consistent-hash (`packages/id-codec/src/jump-hash.ts:28-63`; `JumpShardRouter.getShardForKey`
  `:91-93`). Fewer, bigger DOs; **byte-identical shard identity to the portable path** (important for the
  Slice-5 migration tool's key→shard determinism). Cost: growing N needs a reshard (§5).

**Recommendation: (A) one-DO-per-key as the default `.shardBy` semantic** (CF-idiomatic, dissolves
reshard, matches the "by user/tenant/room" intent and the reference), with **(B) available** for apps
that want bounded DO fan-out or byte-identical portable↔DO shard identity for migration.

### 1.2 Default unsharded ring; `.shardBy` opt-in; the shard key is client-supplied

Keep our existing model: **an unsharded table lives on the single default DO** (`getByName("default")`,
Lunora's `"__root__"`, `shard-do.ts:454`), byte-identical to Slice 3. `.shardBy(field)` in `schema.ts`
is the opt-in.

One reference nuance worth adopting: in Lunora the **shard key is supplied by the client on the RPC
envelope** (`create-worker.ts:47,1214-1219`), falling back to the root shard when omitted; the
`.shardBy(field)` metadata drives *validation/introspection/advisor* checks, not the routing hash
itself. This keeps routing a pure Worker concern and avoids the DO having to parse a row to learn its own
name. We can adopt the same: the client (or the Worker, from the mutation's shard-key arg) supplies the
shard key; a `.shardBy` write missing its key is a typed error (Lunora precedent:
`import-stream.ts:62,72`).

### 1.3 What lives WHERE (the deployment picture)

- **Worker (stateless router):** terminates HTTP/WS; computes the owning DO name from the shard key (or
  `"default"`); forwards. Holds no state (Slice 3 §1.4).
- **transactor-DO per shard:** an independent Slice-3 `StackbaseDO` — writer + its own DO-SQLite + its
  own WebSockets + its own subscription index + its own wake alarm. A single shard-DO differs from Slice
  3 in nothing.
- **`ShardRegistryDO`:** one per deployment, membership only (fan-out/admin discovery).
- **D1 (only if `.global()` is in scope):** one D1 database per deployment for `.global()` tables (§2.2,
  §4), bound to the Worker + DOs.

---

## 2. Cross-shard READ

The task's three options — (a) scatter-gather RPC, (b) D1 global replica, (c) refuse — all appear;
which one applies depends on *whether the read is reactive*.

### 2.1 Shard-scoped reads (blessed) · opt-in non-reactive fan-out (offered) · reactive cross-shard (refused)

**Shard-scoped read (the 95% case, blessed, reactive):** a query over a `.shardBy` table that carries
its shard key (list this room's messages, this tenant's invoices) routes to the ONE owning DO and runs
locally — same store, same snapshot, **read-your-writes trivially** (it's the DO that committed), Slice
3's in-process reactivity unchanged. This is the DynamoDB partition-key model and Lunora's intended
`.shardBy` usage.

**General cross-shard read over `.shardBy` tables (read across many/all keys):** offer it **only as an
opt-in, NON-REACTIVE scatter-gather** — exactly Lunora's "Query Coordinator": a bounded-concurrency RPC
fan-out to the live shards (from the registry) with a per-shard timeout, merged by a wire-serializable
strategy (`concat | topK | first | max | min | rank | sum | groupBy`; `avg` deliberately unsupported;
failures returned as an `errors` array, never thrown), gated by an explicit `fanOut` flag + an authz
check (`query-coordinator.ts:1-21,74-82,119-124`; `create-worker.ts:39-45,525,1122-1157`; setting both
`shardKey` and `fanOut` is a 400 — "fan-out *is* the shard choice", `create-worker.ts:41`). We already
have the merge engine to port — `ShardedObjectStoreDocStore`'s `mergeSortedAsyncGenerators`
(`sharded-object-doc-store.ts:151-192`) — but on DO each lane read becomes a DO-RPC (latency =
slowest-of-N + N wakes + N billed requests; CF: "Every RPC method call … is a single billed request").

**Do NOT make cross-shard reactive.** A live query joining across `.shardBy` tables must be **rejected**,
following Lunora's `SHAPE_CROSS_SHARD_JOIN` (HTTP 400) with the same actionable message — "denormalize,
or move the table to `.global()`" (`relation-predicates.ts:531,567-569`). Making it reactive drags in
§3's distributed cross-shard invalidation — the biggest correctness risk in the program — for a feature
the strongest reference deliberately refuses.

> **Human decision 3 (§6.3):** offer the opt-in non-reactive `fanOut` read in v1 (recommend — matches
> Lunora's Query Coordinator, ports our objectstore merge, and is honestly-bounded) vs. NON-GOAL it
> entirely (leaner v1). Either way, **reactive cross-shard is a hard non-goal in v1.**

### 2.2 `.global()` → D1, the escape hatch for genuinely-global data

A `.global()` table lives in **D1**, with a real column-per-field schema and real secondary/`.unique()`
indexes — written **write-through, synchronously, from inside the owning shard-DO's request** (not async
CDC): the DO's ctx-db routes any op on a `global`-mode table to an injected D1-backed `globalDb`
(`.reference/lunora/packages/do/src/ctx-db.ts:352,1619,2364,2698`; DDL in
`.reference/lunora/packages/sql-store/src/ctx-db.ts:977-1049`). Reads are ordinary D1 SQL, so
"query across everything" and cross-row joins are D1's job. **Read-your-writes uses the D1 Sessions
API:** `env.DB.withSession(bookmark ?? "first-unconstrained")`, with the bookmark threaded end-to-end via
the `x-d1-bookmark` header — client stores/sends it, Worker forwards, DO stashes per-request + echoes
after a write, Worker returns it (`.reference/lunora/packages/d1/src/d1-client.ts:154-164,231-232`;
thread: `create-worker.ts:1034,1054-1055,2318-2325`; `shard-do.ts:1908-1911,2727-2743,1207-1211`). CF:
a session is "sequentially consistent"; `first-primary` forces the freshest read; `first-unconstrained`
(the default) serves any replica for lowest latency and is stale-tolerant (D1 Sessions docs). D1 is
itself SQLite-on-a-DO (10 GB max, single primary writer + auto read replicas per region), so `.global()`
inherits a **single-primary write ceiling** — the escape hatch for globally-shared / low-write data, not
the default.

> **Human decision 4 (§6.3):** is `.global()`/D1 IN v1, or is v1 `.shardBy`-only with global data a
> documented non-goal? Recommendation: **design `.global()` now, ship it as milestone 2** — it is the
> load-bearing dependency for cross-shard reads AND global-unique (§4).

### 2.3 Consistency + latency summary

| Read kind | Path | Latency | Read-your-writes? | Reactive? |
|---|---|---|---|---|
| Shard-scoped `.shardBy` | one owning DO, local DO-SQLite | co-located, sub-ms storage | **Yes** (same DO) | **Yes** (in-DO) |
| `.global()` | D1 via Sessions API | replica (region-local) or primary | **Yes** (bookmark) | **poll** (coarse, §3.2) |
| Cross-`.shardBy` `fanOut` | scatter-gather DO-RPC + merge | slowest-of-N + N wakes | committing shard only | **No** (opt-in, non-reactive) |

---

## 3. Cross-shard INVALIDATION — the correctness crux (and why v1 sidesteps it)

The locked model: a subscribed query re-runs when a committed write-set intersects its recorded read-set.
The deep question: when a query's read-set spans shards, how does a commit on shard-A notify a
subscription that also read shard-B, preserving the shipped **G1/G4** frontier ordering across the RPC
hop? The answer this spec adopts — following Lunora — is **don't let that situation exist for the
reactive path.**

### 3.1 In v1, a REACTIVE subscription NEVER spans shard-DOs — so the crux does not arise

Because v1 offers only **shard-scoped** `.shardBy` reactive queries and **`.global()`** live queries,
every *reactive* subscription's read-set lives on exactly ONE substrate:

- A **shard-scoped `.shardBy` subscription** lives entirely on its one owning transactor-DO. Commit,
  read-set, and fan-out are all in that one DO — **byte-for-byte Slice 3's in-process path**. G1/G4 hold
  "because there is no RPC hop to cross" (Slice 3 §2.2). No new engine surface. A live query that would
  need another shard is **rejected** (`SHAPE_CROSS_SHARD_JOIN`, §2.1), not silently served stale.
- A **`.global()` subscription** reads D1 (§3.2).

So the hardest distributed-ordering problem is **deferred by construction**, not solved-and-hoped. This
is the payoff of matching Lunora's scope instead of overreaching.

### 3.2 `.global()` table reactivity — poll first, CDC-notify as an upgrade (milestone 2)

A `.global()` table has no per-DO op-log, so its live queries cannot be poke-invalidated locally.
**Lunora's shipped answer is the honest v1 minimum: POLL.** The DO re-reads each subscribed global
shape's membership from D1 on a wall-clock **alarm**, re-arming while global subscribers remain — a
seconds-floor latency, explicitly "can't be poke-live" (`shard-do.ts:1416-1421,2388-2436`). This reuses
our shipped **wake seam** (`armWake`/`fireDueTimers`, the DO alarm) directly — a global-shape poll is
just another due-timer callback. Ship this first.

**The lower-latency upgrade (optional, measure before building):** turn the Slice-3 `notifyWrites` seam
into a cross-DO notify. On a `.global()` commit the owning writer-DO writes D1, appends a `_global_cdc`
change record (Lunora's `__cdc_log` shape: AUTOINCREMENT `seq`, resumable watermark,
`.reference/lunora/packages/do/src/ctx-db-cdc.ts:22,38-146,158`), invokes in-DO `notifyWrites` for local
global-subscribers, and **cross-DO RPC-notifies** the (few) other DOs holding global subscribers —
carrying `origin` session id + commit `ts`, **inline not `waitUntil`**, so the committing client's
`MutationResponse` never beats its own frontier advance (G4 across the hop, exactly Slice 3 §2.3). For
many subscriber-DOs, a change-stream/hub (Concave "change stream … avoid direct N-way notify",
`llms-full.txt:1442-1444`; Lunora's `relay-hub` is the intra-shard connection-fan-out precedent,
`relay-hub.ts:1-19`) is the scale design — YAGNI until the poll's latency is measured insufficient.

The honest bound either way: `.global()` reactivity is **eventually-consistent** (poll interval, or
notify latency), not the sub-ms in-DO path. Read-your-writes for the *committing* client stays exact (its
own D1 write + bookmark); a *third-party* client sees the change at poll/notify latency. Document it in
`docs/enduser/`.

### 3.3 Named ordering pitfalls (the D12 class, restated for DO)

1. **A cross-DO `notifyWrites` RPC must not be `waitUntil`-deferred** — same rule Slice 3 §2.2
   established; deferral lets a `MutationResponse` beat its origin-frontier advance (G4 violation).
2. **No synchronous cross-oracle fan-out exists across DOs** (§0.2). Any design that lets one *reactive*
   query's snapshot span shard-DOs re-opens the stale-forever class as a distributed frontier problem.
   v1 avoids it by construction (§3.1); do not quietly relax the shard-scoped rule without re-proving
   frontier ordering (port `ReplicaTailer` `F = min(frontier_ts)`, `replica-tailer.ts:24-26`).
3. **Global-CDC/poll is at-least-once / may lag** — the `seq` watermark + resume means a crash between
   notify and watermark-advance redelivers; a poll may briefly show stale membership. Every change
   carries a stable id for dedup (our shipped triggers `changeId` precedent).

---

## 4. Global secondary index / UNIQUE constraint across shards

Where "distributed database" ambition meets reality. Blunt version:

### 4.1 A UNIQUE index over a `.shardBy` table is INFEASIBLE without a global authority

A `.shardBy` write on shard-DO-A cannot see keys owned by shard-DO-B without an RPC to B — and *global*
uniqueness would require checking *every* shard on the write path, inside the single-threaded transactor
turn, which the write ceiling makes ruinous. DO offers **no primitive** to make this atomic across
objects. Lunora confirms the negative: a `UNIQUE`/`.unique()` index is an ordinary single-database
`CREATE UNIQUE INDEX`, enforced only within that one DO — for a `.shardBy` table, "uniqueness holds only
within one shard, never across the key space"; there is no global-index DO and no cross-shard uniqueness
check (`.reference/lunora/packages/sql-store/src/ctx-db.ts:1040-1049,2111-2119`;
`.reference/lunora/packages/do/src/ctx-db.ts:1129-1134`). Options:

- **(a) D1 as the global index (Lunora's actual answer).** A `.unique()` on a `.global()` table is a
  real `CREATE UNIQUE INDEX` on D1, enforced by D1's own SQLite; a violation surfaces as a typed
  conflict (`ctx-db.ts:1040-1049`). **Global-unique = put the table in `.global()`.** D1's single primary
  is the serialization point that makes it correct.
- **(b) A dedicated index-DO** — every `.shardBy` insert RPCs a reserve-key first. Recentralizes the
  contention sharding removed (the index-DO becomes the single-thread bottleneck) and adds a
  2PC-shaped write path. **Not recommended.**
- **(c) Non-goal.** No cross-`.shardBy` unique in v1.

### 4.2 Recommendation

**Global-unique is a `.global()`/D1-ONLY capability; a `.unique()` on a `.shardBy` table is rejected at
schema-load** with a clear error ("a unique index on a sharded table must be `.global()`"). Honest,
matches the reference, pushes the one correct serialization point (D1's primary) onto the platform.
**Uniqueness *within a shard key* is still free** — a `.shardBy("roomId")` table can enforce a unique
`(roomId, slug)` locally on its one DO. Document the distinction (per-shard-unique = free;
cross-shard-unique = `.global()` only).

> **Human decision 5 (§6.3):** global-unique via D1-only (recommend), dedicated index-DO (don't), or
> non-goal (if `.global()` is cut). Recommendation: **D1-only, shipped with the `.global()` milestone**;
> until then cross-shard-unique is a documented non-goal and per-shard-unique works.

---

## 5. Reshard — growing shard count

### 5.1 Which of our two reshards applies

Our shipped code has two, opposite:
- **Fleet reshard** — logical lanes over one shared store → **moves NO rows**
  (`ee/packages/fleet/src/reshard.ts` note). Does not apply to DO (DO shards are physical).
- **Object-store reshard** (`ee/packages/objectstore-substrate/src/reshard.ts`) — physical lanes → a doc
  whose lane changes is **PHYSICALLY MOVED between lane logs**. The DO analog. Explicitly **OFFLINE /
  stop-the-world, non-atomic, not resumable**: (1) GATE — refuse if any lane has a live lease; (2)
  MATERIALIZE each lane to memory; (3) RE-PARTITION by `shardIdForKeyValue(doc[shardKey], M)`; (4)
  REWRITE — delete then re-write every lane fresh; (5) set `numShards = M` LAST as the linearization
  point (`reshard.ts:2-21,75-177`).

Lunora's precedent for online reshard: **there is none** — only a `hot_shard` advisor lint that detects
skew and tells you to re-shard manually (`.reference/lunora/packages/advisor/src/lints/runtime/hot-shard.ts:23-48`);
its `data-migration.ts` is in-place row-transform, never row-move; bulk cross-DO movement is manual
admin export/import only.

### 5.2 Recommendation — and the routing choice that dissolves it

- **Routing (A) one-DO-per-key (§1.1, recommended):** **there is no reshard.** N is not fixed; a new key
  is a new DO forever; a key's DO never changes. Major argument *for* (A). Ship a `hot_shard`-style
  advisor lint (port Lunora's) so a giant single key gets flagged (§7 #8) rather than silently filling
  one DO.
- **Routing (B) fixed-N hash:** port the object-store reshard to move rows **between DO-SQLite
  databases** (DO-to-DO: read source, re-partition by `shardIdForKeyValue(·, M)` — jump-hash movement-
  minimality means N→M only moves keys landing in new buckets, `jump-hash.ts:10-13` — write into
  targets, flip `numShards` last). **OFFLINE/stop-the-world in v1**, gated on a deployment-wide drain,
  matching the object-store contract. **Online reshard is explicitly out of scope** (as it is for the
  shipped object-store path and for Lunora entirely).

> **Human decision 6 (§6.3):** if routing (B), accept offline/stop-the-world reshard for v1 (recommend);
> if routing (A), reshard is a non-issue and this is moot.

---

## 6. The honest verdict + v1 scope + build order

### 6.1 Verdict

**BUILDABLE BEHIND THE SEAMS as a reduced v1 that matches the portable path's *opt-in* shape and the
strongest reference (Lunora) almost verbatim — with `.global()`/D1 as a named, in-scope dependency for
the cross-shard-read and global-unique capabilities.** It is NOT "port cross-shard query from the
portable path" (that freeness is a single-process artifact DO cannot have, §0). It is NOT a distributed
*reactive* query planner (Lunora refuses it with a 400; do not build it). The two capabilities that
genuinely need external help — reactive cross-shard read (refused) and global-unique — resolve to **the
same D1 dependency**, cleanly.

Against the roadmap's gate ("a query across 4 shards returns correct merged results; a global
unique-index violation is rejected; write throughput scales ~linearly with shard count", `:189-191`):
"query across 4 shards" is served by **the opt-in `fanOut` merge** (non-reactive) OR **`.global()`/D1**;
"global unique violation rejected" is **D1's UNIQUE index**; "write throughput scales ~linearly" is the
**`.shardBy` per-DO writer** (each shard-DO its own single-thread ceiling; N shards → ~N× aggregate). The
gate is met — via D1 for the global half and a bounded fan-out for the merge half, not via a home-grown
distributed reactive planner.

### 6.2 What our existing multi-shard path already gives vs. what Slice 6 adds

| | Portable multi-shard (shipped) | Slice 6 v1 (this spec) |
|---|---|---|
| Write scale-out | per-shard mutex/OCC over one store (transactor concurrency only; SQLite still serializes storage) | **real** horizontal write scale: N separate DO-SQLite writers, N× the single-thread ceiling AND N× the 10 GB storage |
| Cross-shard query | **free + reactive** (single shared store / in-process lane-merge) | shard-scoped reactive on `.shardBy`; **opt-in non-reactive** `fanOut` merge; global via `.global()`/D1 |
| Cross-shard invalidation | **free** (one global registry) | shard-scoped = in-DO (free, Slice 3); reactive cross-shard = **refused** (400); global = poll/CDC (new, milestone 2) |
| Global unique | works (one store) | **`.global()`/D1 only**; `.unique()` on `.shardBy` rejected at schema-load |
| Reshard | offline (object-store) / no-op (fleet) | **none** (routing A) or **offline** (routing B) |

The delta is a real capability *reduction on the reactive query surface* in exchange for a real *physical
write-scale gain* — the DynamoDB trade, exposed as `.shardBy` vs `.global()`. Flag it (human decision 2).

### 6.3 The load-bearing human decisions (do not unilaterally decide)

1. **Routing:** (A) one-DO-per-shard-key (recommend; dissolves reshard, CF-idiomatic, matches Lunora)
   vs. (B) fixed-N jump-hash (byte-identical to portable, needs reshard). §1.1.
2. **The `.shardBy` semantic divergence:** accept that a *reactive* cross-key query works on portable but
   requires `.global()` on DO (documented "same code, different capability under opt-in `.shardBy`").
   §0.3.
3. **Cross-shard scatter-gather over `.shardBy`:** offer opt-in NON-REACTIVE `fanOut` read (recommend —
   matches Lunora, ports our merge) vs. NON-GOAL it. **Reactive cross-shard is a hard non-goal either
   way.** §2.1.
4. **`.global()`/D1 in v1?** Yes, as milestone 2 (recommend — the dependency for cross-shard read AND
   global-unique) vs. defer, leaving both as non-goals. §2.2.
5. **Global-unique:** D1-only (recommend) vs. index-DO (don't) vs. non-goal. §4.2.
6. **Reshard (only if routing B):** offline/stop-the-world in v1 (recommend). §5.2.

### 6.4 Build order for the v1-scoped subset (bite-sized)

Two milestones. **Milestone 1 (`.shardBy` write scale-out) has NO new engine surface** — N independent
Slice-3 hosts + a routing rule. **Milestone 2 (`.global()`/D1 + fan-out) is the new surface** — where
cross-shard read + global-unique + global reactivity land, all on D1.

**Milestone 1 — `.shardBy` multi-shard writers (ship + prove FIRST):**
- **T1. Router shard resolution.** In `runtime-cloudflare`'s Worker, resolve the owning DO from the
  request's shard key (routing (A) `getByName(canonicalKey)` or (B) `getByName("s"+jumpHash)`);
  unsharded/`"default"` unchanged. Reject a `.shardBy` write missing its key with a typed error. Gate:
  workerd unit test routes two keys to two DO instances; a mutation commits on the right one.
- **T2. Per-shard host is just Slice 3.** Confirm a shard-DO is an unmodified `StackbaseDO`; no engine
  change. `ShardRegistryDO` registers first-seen keys (`ctx.waitUntil`). Gate: two shard-DOs commit
  independently, each single-threaded.
- **T3. Shard-scoped reactive query E2E (real Cloudflare).** Subscribe to room-A on its DO; commit to
  room-A from a second client → reactive push; commit to room-B → room-A subscriber gets NOTHING (proves
  isolation, not a leak). A live query that would join room-A+room-B is **rejected** (400). Measure
  aggregate write throughput across shards ≈ N× single-DO (roadmap "scales ~linearly", `:191`).
- **T4. Deploy rig + neutrality.** `wrangler.jsonc` DO-namespace binding for the shard class + the
  registry DO; `DurableObjectNamespace`/cloudflare/D1 types appear only in `runtime-cloudflare` (+ the D1
  adapter, M2). Full existing suite + container path green.

**Milestone 2 — `.global()`/D1 + opt-in fan-out:**
- **T5. D1 adapter package** (`@stackbase/docstore-d1` or the `.global()` store) — column-per-field DDL
  from `schema.ts`, `.unique()` → `CREATE UNIQUE INDEX`, `withSession(bookmark)` read-your-writes
  (bookmark threaded via `x-d1-bookmark`). Ship against a D1-backed behavior suite (mirror `@lunora/d1`).
  Engine stays D1-unaware (all D1 types in this package).
- **T6. `.global()` schema mode + routing.** `schema.ts` `.global()` marks a table D1-resident;
  write-through from the owning DO; global reads route to D1 (bookmark to the client); reject `.unique()`
  on a `.shardBy` table at schema-load.
- **T7. Global reactivity — poll first.** Reuse the wake seam: a due-timer alarm re-reads each subscribed
  global shape's membership from D1 and invalidates (Lunora `pollGlobalShapes`). Gate (real Cloudflare):
  a `.global()` write from one client is seen by a global subscriber on another DO within the poll
  interval; a global-unique violation is rejected; read-your-writes holds via bookmark. (CDC-notify
  upgrade deferred, §3.2.)
- **T8. Opt-in non-reactive `fanOut` read** (if human decision 3 = offer it) — port the objectstore
  `mergeSortedAsyncGenerators` merge to a bounded DO-RPC fan-out over the registry's live shards, gated
  by an explicit `fanOut` flag + authz, failures as data. Gate: a `fanOut` query across 4 shard-DOs
  returns correct merged results (roadmap gate, `:189`).
- **T9. Reshard tool** (only if routing (B)) — port the offline object-store reshard to move rows between
  DO-SQLite databases; gate on a deployment drain; `numShards` flip last. Gate: N→M offline reshard,
  identical query results after.
- **T10. Docs + honest numbers** — the `.shardBy` vs `.global()` decision table; per-shard-unique vs
  cross-shard-unique rule; global reactivity poll-latency bound; measured cross-shard/global latency vs
  the shard-scoped sub-ms path; the `hot_shard` advisor lint.

---

## 7. Adversarial: where this bites, and what stays honest

1. **"Just port the objectstore scatter-gather" is a trap for the *reactive* path.** The merge ports
   (`sharded-object-doc-store.ts:151-192`), but in-process → N DO-RPC changes the cost model by orders of
   magnitude AND drags in §3's distributed invalidation. Fine as a *non-reactive* `fanOut` (Lunora's
   Query Coordinator scope); wrong as a reactive default. Lunora enforces the line with a hard 400.
2. **`onCommitted`'s synchronous cross-oracle ordering (the D12 fix) does not exist across DOs** (§0.2).
   Any design letting one *reactive* query's snapshot span shard-DOs re-opens the one-frame-flicker /
   stale-forever class as a distributed frontier problem. v1 avoids it by construction; do not quietly
   relax the shard-scoped rule.
3. **A cross-DO `notifyWrites` RPC that is `waitUntil`-deferred violates G4** — same edge Slice 3 §2.2
   flagged, now across the hop.
4. **`.global()` inherits D1's single-primary write ceiling** (D1 is SQLite-on-a-DO; 10 GB max; auto read
   replicas but one writer). Escape hatch for globally-shared/low-write data, NOT a write-scale path.
   Advisor/lint opportunity (Lunora warns; a high-write `.global()` table is an anti-pattern).
5. **D1 read replicas are eventually consistent without a bookmark** — a `.global()` read that skips the
   Sessions bookmark can go stale/backwards (`first-unconstrained`). The adapter threads the bookmark by
   default; document the `first-primary` knob for the rare must-be-freshest read.
6. **Routing (A) unbounded DOs make "list all shards" impossible without the registry** — a genuine cost
   of one-DO-per-key. Right default *because* it pushes apps to shard-scoped queries and `.global()`, but
   an admin "browse all rooms" needs the `ShardRegistryDO` (Lunora keeps one, admin-scoped). Don't
   accidentally need it on the hot path.
7. **Migration tool (Slice 5) shard identity.** Routing (A) (key-as-name) and (B) (jump-hash) produce
   *different* key→shard mappings than the portable path unless (B) reuses `shardIdForKeyValue` verbatim.
   If byte-identical portable↔DO data movement matters, that argues for (B). A real input to decision #1.
8. **A shard-DO can still hit 10 GB.** `.shardBy` fixes aggregate storage, but ONE hot shard key (a giant
   tenant) can fill its own DO's 10 GB (`SQLITE_FULL`, Slice 2's typed error). No cross-shard rebalance of
   a single key exists (that's a sub-shard split — out of scope). Ship the `hot_shard` advisor; document
   the hot-key ceiling — same class as DynamoDB's hot-partition limit.
9. **Concave's "keep one writer" is NOT an escape** (§0.1) — it shards *sync*, not *writes*; it is already
   Slice 3 and does not scale writes. Do not let a reviewer conflate the two and conclude Slice 6 is
   unnecessary.
10. **Cross-backend cascades are refused, not silent** — Lunora refuses an `onDelete` from a `.global()`
    parent into a `.shardBy` holder ("would require Query Coordinator fan-out across shards",
    `sql-store/src/ctx-db.ts:2521-2523`) and requires `tenantBy` on a sourced `.shardBy` table. If we add
    relations across the `.shardBy`/`.global()` boundary, refuse loudly at schema-load; do not silently
    fan out on a delete.

---

## Appendix — evidence index (file:line)

| Concern | Where |
|---|---|
| Roadmap Slice 6 scope + gate | `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md:174-191` |
| Research change #4 (cross-shard = genuinely new surface) | `docs/dev/research/cloudflare-do-native-host.md:42-47`, `:86-91` |
| DO hard limits (single-thread ~200–500 w/s, 10 GB) | `docs/dev/research/cloudflare-do-native-host.md:18-24,30-33` |
| Slice-3 `notifyWrites` origin-seam forward-designed for Slice 6 | `docs/superpowers/specs/2026-03-20-do-host-slice3-design.md:112-114,182-190` (`§2.2` inline-not-waitUntil) |
| Our `ShardedTransactor` (per-shard mutex/OCC, shared store, one fan-out) | `packages/transactor/src/sharded-transactor.ts:1-11,24,28-29,63-68,180` |
| `onCommitted` cross-oracle fan-out (D12 fix, synchronous, pre-publish) | `packages/transactor/src/sharded-transactor.ts:88-104,120-123,184-193`; `packages/transactor/src/shard-writer.ts:411,421,436-438` |
| Query never routed → reads whole store at default oracle | `packages/transactor/src/sharded-transactor.ts:83,88-94`; `packages/query-engine/src/query-runtime.ts:135-138,211` |
| One global shard-agnostic `SubscriptionManager` (range∩range, no shard dim) | `packages/sync/src/handler.ts:228`; `packages/sync/src/subscription-manager.ts:96-115` |
| `notifyWrites(inv, origin)` (the seam that becomes the RPC) | `packages/sync/src/handler.ts:730,842-857`; `packages/runtime-embedded/src/write-fanout.ts:20` |
| Objectstore in-process scatter-gather-merge (reads fan out, writes route) | `ee/packages/objectstore-substrate/src/sharded-object-doc-store.ts:14-20,151-192` |
| Objectstore reshard = offline/stop-the-world physical move | `ee/packages/objectstore-substrate/src/reshard.ts:2-21,65-67,75-177` |
| Jump-consistent-hash routing + movement-minimality | `packages/id-codec/src/jump-hash.ts:10-13,28-63,91-93` |
| Fleet dense frontier `F = min(frontier_ts)` (precedent for future distributed reactive query) | `ee/packages/fleet/src/replica-tailer.ts:24-26,44-46`; `ee/packages/fleet/src/node.ts:67-70,398-402` |
| Runtime builds `ShardedTransactor` only when `numShards>1` (opt-in) | `packages/runtime-embedded/src/runtime.ts:437-445` |
| Lunora table mode = root \| shardBy \| global (closed union) | `.reference/lunora/packages/server/src/types.ts:16,28`; `schema.ts:242,281-283,350-352` |
| Lunora routing `getByName(shardKey)`; shard key client-supplied on envelope | `.reference/lunora/packages/runtime/src/resolve-shard.ts:64-73`; `create-worker.ts:47,1214-1219,1468` |
| Lunora root shard `"__root__"` + >1GiB migrate warning | `.reference/lunora/packages/do/src/shard-do.ts:454,4446-4460` |
| Lunora `ShardRegistryDO` (membership only, ~30s cache) | `.reference/lunora/packages/do/src/shard-registry-do.ts:1-33`; `dynamic-shard-registry.ts:49-57` |
| Lunora Query Coordinator (opt-in `fanOut`, merge strategies, failures-as-data, non-reactive) | `.reference/lunora/packages/runtime/src/query-coordinator.ts:1-21,74-82,119-124`; `create-worker.ts:39-45,525,1122-1157` |
| Lunora cross-shard REACTIVE join REJECTED (`SHAPE_CROSS_SHARD_JOIN` 400) | `.reference/lunora/packages/do/src/relation-predicates.ts:531,567-569` |
| Lunora `.global()` reactivity = poll D1 on alarm (not poke-live) | `.reference/lunora/packages/do/src/shard-do.ts:1416-1421,2388-2436` |
| Lunora `.global()` write-through to D1 `globalDb` (synchronous, in-DO) | `.reference/lunora/packages/do/src/ctx-db.ts:352,1619,2364,2698`; DDL `sql-store/src/ctx-db.ts:977-1049` |
| Lunora `.unique()` on `.shardBy` = per-shard only; global-unique = D1 | `.reference/lunora/packages/sql-store/src/ctx-db.ts:1040-1049,2111-2119`; `do/src/ctx-db.ts:1129-1134` |
| Lunora D1 Sessions read-your-writes (`withSession`/bookmark/`x-d1-bookmark` thread) | `.reference/lunora/packages/d1/src/d1-client.ts:154-164,231-232`; `create-worker.ts:1034,1054-1055,2318-2325`; `shard-do.ts:1908-1911,2727-2743,1207-1211` |
| Lunora `__cdc_log` (resumable per-shard change stream, for the notify upgrade) | `.reference/lunora/packages/do/src/ctx-db-cdc.ts:22,38-146,158` |
| Lunora NO online reshard (only `hot_shard` advisor lint) | `.reference/lunora/packages/advisor/src/lints/runtime/hot-shard.ts:23-48` |
| Lunora refuses global→shardBy cascade; sourced `.shardBy` needs `tenantBy` | `.reference/lunora/packages/sql-store/src/ctx-db.ts:2521-2523`; `server/src/schema.ts:660-662` |
| Lunora topology (default single DO; `.shardBy` by user/tenant/room; `.global()` D1) | `.reference/lunora/CLAUDE.md` (Architecture Overview; `@lunora/d1` row) |
| Concave shards SYNC, not writes (singleton writer + sync-shard pool + change stream) | `.reference/concave-docs-raw/llms-full.txt:1430-1444,1523-1537` |
| CF: `getByName` globally-unique name → stub (no shard map) | CF changelog 2025-08-21 (cloudflare-docs MCP) |
| CF: each DO RPC method call = one billed request | CF DO/Workers pricing (cloudflare-docs MCP) |
| CF: D1 Sessions API (`withSession`, `first-primary`/`first-unconstrained`/bookmark, sequential consistency) | CF D1 read-replication beta 2025-04-10 + `withSession()` docs (cloudflare-docs MCP) |
| CF: D1 max DB size exceeded → "shard your data into multiple databases" | CF D1 debug/limits (cloudflare-docs MCP) |
</content>
