All load-bearing code claims in the critiques verified against the tree (epoch bumps only on advisory-lock acquisition in `ee/packages/fleet/src/lease.ts:51-62` — so lease expiry and fencing are genuinely different events; tailer pulls to `primary.maxTimestamp()` at `replica-tailer.ts:207`; `RYOW_WAIT_MS = 5000` scalar wait in `forwarder.ts:39`; ring/snapshot discipline in `single-writer-transactor.ts:166-225`; dormant `.shardKey` and `WriteRouter.forward` seams). The critiques argued about real code. Verdict follows.

---

# VERDICT: Design A's skeleton wins — as the **Fenced Frontier** protocol, with five grafts the critiques made mandatory

## (a) Verdict and rationale

**Design A (central-order, parallel-execute) is the architecture, conditional on adopting fencing-first eviction — without which it is broken — plus four organs grafted from B and C.** The judgment traces the stated priority order. On correctness of the reactive core: the correctness critique falsified A *as written* (the live-lease-exclusion rule readmits the skipped-ts-99 bug via an idle-in-transaction straggler on an expired-but-unfenced lease — confirmed possible against the shipped lease code, where epoch only advances on advisory-lock acquisition), but the same critique supplied and endorsed the fix: eviction from the min must be a fencing UPDATE on the lease row itself, which Postgres row-locking serializes against any in-flight commit's frontier UPDATE on that same row, forcing exactly one of {straggler lands and is counted, fencer wins and straggler aborts}. That is a protocol bug with a one-row, mechanically testable repair. Design B's flaw is the opposite kind: its consistent-cut theorem holds only for write-write dependencies, so cross-session effect-before-cause on the headline feature (a reply visible before the message it replies to) is *permanent product semantics*, invisible at P=1 in every dev environment, unfixable without unforking the timeline — and its frozen-read staleness (including every auth check in every sharded mutation) is unbounded. A subscription that can show effect before cause has lost the reactive-core correctness argument in the sense that matters: the contract users observe. Design C accumulated four independent safety liabilities (the same eviction-vs-fence gap stated more vaguely, a ~31-day 2^53 bomb its own tests cannot catch, unspecified ack/batch-abort semantics on which commit-means-durable hangs, and an all-reads-at-global-frontier posture that maximizes wedge blast radius) plus an unflaggable bet-the-engine slice 0 — dead on buildability alone. Corrected-A then dominates on DX (zero migration, zero wire change, scalar `StateVersion`/RYOW/cursors preserved, the deferred version-gap resync kept alive, no four-tier consistency contract to teach), ties or acceptably trails on deploy-anywhere, matches B on throughput now and exceeds it after grafting C's group commit, and is the cheapest to build — its slice 1 is a pure hardening win on the *shipped* fleet even if sharding stopped there.

## (b) The chosen protocol, end-to-end: **Fenced Frontier**

One global ts line. Per-shard parallel OCC writers. Visibility = min over per-shard frontiers that are published atomically inside each commit's own Postgres transaction, on the same row that is the lease and the fence. Eviction from the min only ever happens *after* a completed fence.

### Timestamp allocation

The **store allocates** `commitTs` — one contract at every tier, two implementations (this resolves critique 3's dual-regime attack: the in-memory oracle moves behind the `DocStore` seam, and the SQLite store implements the same write-returns-ts contract with its existing counter, both covered by the shared conformance suite):

```sql
-- inside every commit's PG transaction (Postgres store, fleet mode)
BEGIN;
  SELECT nextval('stackbase_ts');                        -- ts for this whole commit
  INSERT INTO documents (..., ts, shard_id) ...;         -- all rows stamped ts
  INSERT INTO indexes   (..., ts, shard_id) ...;
  UPDATE shard_leases
     SET prev_ts = frontier_ts, frontier_ts = $ts
   WHERE shard_id = $s AND epoch = $myEpoch;             -- 0 rows -> ROLLBACK, FencedError, self-demote
COMMIT;  -- ts becomes visible atomically with its rows: no allocated-but-unlanded window exists
```

Per-shard ts strictly increases (shard mutex serializes commits), which is exactly what the OCC ring's strict-`>` check needs. `nextval` consumption at worst-plausible rates keeps `Number(ts)` under 2^53 for centuries — no C-style precision bomb, `_creationTime` semantics unchanged, **no migration**.

### Visibility rule and the exact reader algorithm

`frontier_ts(s)` means: every shard-s commit with `ts <= frontier_ts(s)` is durably present and dense; every future shard-s commit exceeds it. **F = min(frontier_ts) over ALL shard rows — never filtered by lease liveness.** Consumers take `max(F_new, F_prev)`; F never regresses.

**Fencing-first eviction (the non-negotiable amendment).** A shard leaves the min only by having its row fenced, never by a clock:

```sql
-- any node observing expires_at < now() on shard s (lock_timeout + retry loop):
UPDATE shard_leases
   SET epoch = epoch + 1, writer_url = NULL,
       frontier_ts = GREATEST(frontier_ts, nextval('stackbase_ts'))
 WHERE shard_id = $s AND expires_at < now();
```

This UPDATE blocks behind any in-flight commit's row lock on the same row. Either the straggler commits first (its ts is then `<= frontier_ts`, counted — and F never passed it, because the shard was still holding the min down the whole time), or the fencer wins and the straggler's epoch-predicated UPDATE matches zero rows and its entire transaction aborts. Writer connections set `idle_in_transaction_session_timeout` (~5s) and `statement_timeout` so a wedged session dies in bounded time. After fencing, the orphaned shard (`writer_url IS NULL`) is frontier-bumped by the fencer/balancer until re-leased, so F keeps advancing while the shard has no writer; the old writer, if it revives, self-demotes on its first `FencedError`. Normal promotion still requires the per-shard advisory lock; the epoch fence protects the log in the interim.

**Frontier closing (kills A's 200 ms tax; adopts C's O(nodes) economics).** No naive per-shard heartbeat. Each node runs ONE batched transaction — a single `nextval` N is a valid frontier for *all* of its idle shards at once, since any future commit takes a later `nextval` — triggered (a) periodically at H=100 ms, and (b) event-driven: on observing a commit NOTIFY with ts above its own idle frontiers, coalesced ~10 ms. Bookkeeping is O(nodes) transactions per beat, independent of shard count; F closes over a new commit in ~10–30 ms on a multi-node fleet (one NOTIFY round + one batched UPDATE), per-commit on busy shards, and the lag of a fully idle system is unobservable because there is nothing to push.

**Readers, exactly:**

- **Mutation execution** (writer node, home shard s): split snapshot — home shard at `lastCommitted(s)` from the primary (hot, serializable), unsharded/global tables at the node's applied F from its local replica (recorded in the read set for invalidation precision, *not* OCC-validated; each half individually stable, so deterministic replay re-reads identically). Reads of a *different sharded table's foreign shard*: rejected with an instructive error.
- **Replica tailer**: `F_target = min(frontier_ts)`; pull `(wm, F_target]`, apply grouped by ts (atomic per ts), **assert per-shard `prev_ts` chains** (density violations crash loudly instead of corrupting silently), `wm := F_target`. The skipped-ts window is now closed by construction *including* the failover path.
- **Queries, subscriptions, `StateVersion`, pagination cursors**: evaluated at the node's `wm` (= F). `StateVersion.ts` stays a scalar; the client protocol is byte-identical; "everything <= ts is reflected" stays literally true, so the deferred version-gap-resync optimization stays alive. A `StablePrefixTs` branded type makes feeding a raw log ts where a frontier is required a compile error.
- **RYOW**: `/_fleet/run` returns `{shardId, commitTs}`. v1 serves after `wm >= commitTs`, with the wait made progress-aware (the flat 5000 ms timeout in `forwarder.ts` becomes "keep waiting while F is advancing; surface a frontier-stall warning naming the pinning shard/node when it is not") — the correctness critique's RYOW-timeout-under-stall attack is answered by making stalls observable waits, not silent staleness or errors.

**Honest failure envelope** (repriced per the critiques, not per Design A's original marketing): a *crashed* writer aborts its in-flight PG transactions instantly (session death), is fenced and re-leased within lease TTL; only that shard's writes stall; F resumes within seconds. A *wedged-but-alive* writer (GC pause, idle-in-transaction) stalls F fleet-wide — all subscription pushes and RYOW waits go stale — for up to `idle_in_transaction_session_timeout` + fence completion (bounded single-digit seconds), while healthy shards' writes keep committing (invisibly until F resumes) and single-shard mutation execution stays hot. This is the deliberate price of one timeline versus B's per-group isolation: a rare, bounded, *observable*, non-corrupting stall in exchange for never showing effect-before-cause. Frontier-lag observability therefore ships **with** the sharding slice, not as deferred polish.

### OCC scope

Per shard, today's machinery verbatim: mutex, `recentCommits` ring, `activeSnapshots`, conflict iff `c.ts > snapshotTs(s) && reads.intersects(c.writes)` — full serializability within a shard, unchanged code path. One document = one owning shard forever (shard-key field immutable after insert, kernel-enforced). Components co-commit on the caller's shard: scheduler jobs, workflow journals, and their `generationNumber` OCC guard stay shard-local; each shard's lease holder runs its own driver instances; crons and un-sharded apps live on the default shard exactly as today. The named anomaly class: global-table reads inside sharded mutations are stable-snapshot-at-F, not serialized — write skew is possible, *documented with the auth instance named explicitly* (a revoked permission stays effective on non-default shards for the F-staleness window, ~10–100 ms — the same class of revocation lag as any bearer-token/JWT system, stated in the docs as such). Escape hatch for mutations that genuinely need serialized global reads: declare no `shardBy` and run on the default shard, where global tables ARE OCC-validated (spec question 4 decides whether to surface this as an explicit option).

### Routing API

```ts
// convex/schema.ts — one line makes a table sharded (the dormant seam, now live)
messages: defineTable({
  channelId: v.id("channels"),
  body: v.string(),
})
  .index("by_channel", ["channelId"])
  .shardKey("channelId"),

// convex/messages.ts
export const send = mutation({
  args: { channelId: v.id("channels"), body: v.string() },
  shardBy: "channelId",            // names a validated arg; resolver form (args) => ... for derived keys
  handler: async (ctx, { channelId, body }) => {
    const me = await ctx.auth.getUserIdentity();           // global table: F-read, allowed
    await ctx.db.insert("messages", { channelId, body });  // home shard: serializable
  },
});

// client — completely unchanged, shard-blind
await client.mutation(api.messages.send, { channelId, body: "hi" });
```

Resolution is server-side, pre-execution, at the existing `WriteRouter.forward` chokepoint (`runtime.ts:152–154`): `shardId = jumpHash(canonicalBytes(keyValue)) mod NUM_SHARDS`, forwarded over the existing `/_fleet/run` to that shard's lease holder. The client can never name a shard — Lunora's `authorizeShard` attack surface never exists. Addressing critique 3's shared drift-footgun attack: codegen **cross-checks** `shardBy` (the arg exists, is required, and its validator type matches the shard-key field's type of any statically-resolvable sharded writes), and the kernel ownership guard — write to a sharded table from the wrong/undeclared shard throws an instructive error naming the fix — runs at **every tier**, because a row's shardId is a pure function of its key, independent of lease topology.

### Cross-shard reactive subscriptions

Unchanged evaluation: a subscribed query spanning any number of shards runs on a sync node's local replica at F — a stable prefix of the single line, therefore a **true consistent cross-shard snapshot**, never a stitched or torn state and never a causal inversion. Invalidation is the shipped range-intersection machinery, already shard-agnostic; the only wire fix is threading `shardId` through the fan-out payload. Pagination cursors `(indexKey, _id)` remain valid across shards because the snapshot is globally stable. Interleaved cross-shard delta arrival costs at worst an extra re-run, never wrongness, bounded by notify coalescing.

### Per-shard failover

`fleet_lease` generalizes to `shard_leases(shard_id PK, epoch, writer_url, expires_at, frontier_ts, prev_ts)` — **lease, fence, and frontier are one row, so heartbeat, fencing, and frontier publication are one UPDATE each on the same lock domain**, which is precisely why the eviction fix works. Per-shard advisory locks; promotion = the shipped 7-step sequence parameterized by shard; a `ShardLeaseBalancer` on every node targets `ceil(NUM_SHARDS / liveNodes)` leases (symmetric fleet, store-is-coordinator, no placement service). Blast radius: one shard's writes stall <= lease TTL while every other shard keeps committing and all reads keep serving; fleet-wide F stalls only during the fence window, bounded as above.

### Tier-0 degenerate case

`stackbase dev` defaults to **8 virtual shards in one process** (C's tier-uniform-guards graft + B's multi-group-in-one-process graft, which turn out to be the same feature): all leases held locally, forwarding is loopback, shard resolution and ownership guards fully live — so `shardBy` mistakes and illegal cross-shard reads error **on the laptop, day one**, killing the dev-green/prod-red gap that was critique 3's strongest attack on A. Reads at Tier-0 are served from the primary at `lastCommitted` exactly as today — the F machinery exists to make *replica* serving safe, and there are no replicas — so an unsharded app's behavior is byte-identical, and `.shardKey`/`shardBy` are inert annotations for apps that never shard. The identical app code runs on the single binary, `stackbase dev`, a 1-writer fleet, and an N-shard fleet.

### Performance envelope, honest

Uncontended write ack: unchanged (the `nextval` + one-row UPDATE ride the commit transaction that already existed). Write-to-own-subscription-push: unchanged at Tier-0/single-shard; **+10–30 ms on a sharded multi-node fleet** (event-driven F closing), not Design A's misdescribed "ms" and not its naive 200 ms either. Throughput: linear in shard count until the shared Postgres's per-commit fsync budget binds — and the designed answer to that wall is slice B4's per-shard group commit (C's organ: batch a shard's queued commits into one PG transaction with multiple `nextval`s and one frontier UPDATE — per-shard density preserved, several-fold ceiling raise, no protocol change). Two ceilings named and kept: one Postgres (Tier-3's problem — the explicit-frontier protocol is the piece that ports to per-shard object-storage segments + CAS frontier manifests + lease-granted ts ranges), and replica apply amplification (every sync node applies every shard's writes; the read tier's own ceiling — measured in B2, partial replicas are a Tier-3 seam).

## What makes this UNIQUE (and what is honestly borrowed)

Every ingredient is borrowed: the closed timestamp is CockroachDB's, `max_repeatable_ts` is Convex's, the order/execute split is FoundationDB's, per-shard single writers are Lunora/VoltDB's. **The conjunction is what nobody ships:** live, range-precise-invalidated, cross-shard reactive subscriptions over parallel serializable-per-shard writers, at true consistent snapshots, on vanilla Postgres with zero added services and a byte-identical client protocol. Convex never sharded writes (one committer pipeline; we generalize its repeatable-ts to N fenced writers while keeping its client protocol shape intact). Lunora sharded writes and gave up cross-shard live queries (poll-and-diff). CockroachDB's closed timestamps serve stale follower *reads* under a full distributed-transaction stack and side-transport — ours is the spine of a reactive push fan-out, published atomically inside the commit transaction itself, with no distributed transactions anywhere. FoundationDB needs a sequencer *process*; we fold sequencing into the database the commits already flow through (zero extra round trips) and make lease = fence = frontier a single row. The genuinely novel micro-mechanism is that identity: **frontier publication, writer fencing, and lease discovery as one atomic row-update inside the commit, with min-eviction serialized by that row's own lock** — that is the piece no ancestor has and the piece that survives onto object storage.

## (c) Open questions for the spec phase (5)

1. **NUM_SHARDS default and per-shard fixed cost.** Default 8 vs 16 vs 64: per-shard OCC rings, driver instances per lease holder, lease-row fan-in to the min — measure, pick, and document the "choose generously, resharding is offline-tool-only in v1" posture (jump-hash chosen to minimize future movement).
2. **Single-shard fast-path wire semantics (B3).** Serving single-shard read sets at the shard's applied watermark (above F) needs a decision on per-query freshness vs the scalar `StateVersion` bracket — pick the encoding that keeps the version-gap-resync optimization viable.
3. **Stall UX contract.** Exact `idle_in_transaction_session_timeout` / lease-TTL / RYOW progress-aware-wait defaults, and what a client observes during a fence window (wait vs error vs stale-with-flag).
4. **Serializable-globals escape hatch.** Surface "this mutation must serialize its global-table reads → route to default shard" as an explicit API, or leave it a documented pattern? And the auth-freshness stance (documented bound vs pinning identity tables).
5. **Replica apply amplification.** Measure sync-node apply + re-run throughput at N-shard write rates in the B2 E2E; decide where the partial-replica/subscribe-scoped-tailing seam gets reserved for Tier-3.

## (d) Incremental slice plan

- **B1 — Fenced frontier at one shard (pure hardening, behavior-identical, valuable alone).** Store-allocates-ts contract unified across SQLite/PG (conformance-suite covered); `shard_leases` absorbs `fleet_lease` (one `"default"` row = lease+fence+frontier); epoch-fenced commit UPDATE; **fencing-first eviction** + writer-connection timeouts; tailer pulls `(wm, F]`; `shard_id` column + fan-out threading (additive); `StablePrefixTs` branding; `prev_ts` density assertions. Gate: existing fleet E2E green unmodified, plus a new wedged-writer test (SIGSTOP the writer mid-commit, let the lease expire, assert the fence serializes correctly and no ts is ever skipped). This closes the shipped fleet's skipped-ts class and promotion-fencing hole even if sharding stopped here.
- **B2 — N shards live.** `ShardKeyResolver` at `WriteRouter`; `shardBy` API + codegen cross-check; always-on kernel ownership guards; per-shard transactors/rings/leases/promotion/balancer; per-shard scheduler/workflow driver partitions; split snapshot (global tables at F); node-batched event-driven frontier closing; `{shardId, commitTs}` RYOW with progress-aware waits; `stackbase dev` defaults to 8 virtual shards; frontier-lag metric + dashboard tile naming the pinning shard. Gate: E2E through real `stackbase serve --fleet` — two writer nodes committing concurrently on different shards, a cross-shard subscription opened before the writes seeing both consistently, RYOW across a forwarded write, kill one shard's writer while the other keeps committing, zero skipped ts under the density assertions.
- **B3 — Latency and ops polish.** Single-shard fast path (serve single-shard read sets at the shard's applied watermark — collapses the +10–30 ms for the dominant query shape and rescues single-shard RYOW during fence stalls); notify coalescing ticks; forwarder retry-through-failover; stall alerting.
- **B4 — Per-shard group commit.** Batch a shard's queued commits into one PG transaction (multiple `nextval`s, one frontier UPDATE); spec the batch-abort/retry semantics; raises the Postgres fsync ceiling several-fold. This is where the write-throughput headline gets earned.
- **B5 — Design-doc level (not committed code).** Object-storage substrate (per-shard segment logs, CAS frontier manifests with epoch as fence, lease-granted ts ranges for the sequencer seam); offline NUM_SHARDS reshard tool.

## (e) What the rejected designs contributed, and why they died

- **Design B (per-shard logs, frontier vectors)** — died on the product contract, not on safety: cross-session effect-before-cause on the headline cross-shard-subscription feature (structurally permanent, undetectable at P=1 in every dev environment), unbounded frozen-read staleness including every auth check, a four-tier consistency model Stackbase's users were promised they'd never have to learn, and the largest migration/wire surface of the three (`_creationTime` baked into physical index keys, `StateVersion` redefined, RYOW becoming maps — forfeiting the version-gap resync forever). It won both the correctness-safety and performance critiques, and its DNA is all over the winner: **the commit-transaction-atomic frontier-on-the-lease-row is B's mechanism, now serving as corrected-A's safety core**; per-shard applied watermarks and the single-shard fast path (B3); the multi-shard-in-one-process dev mode; the default-deny cross-shard-read posture; the cleanest object-storage stream mapping (B5's blueprint); and the adversarial pressure that exposed A's proof hole.
- **Design C (sequenced epochs)** — died on buildability and blast radius: an unflaggable bet-the-engine slice 0 (structured ts + protocol-v2 client upgrade before any sharding value), a 2^53 truncation window of ~31 days that no normal test suite can catch, unspecified batch ack/abort semantics on which commit-means-durable hangs, and an all-reads-at-global-frontier posture that turns one wedged node into a silent fleet-wide read freeze — the worst possible story for a self-host-anywhere product. Its contributions are load-bearing in the winner: **tier-uniform guard semantics** (shard errors fire in dev — grafted as B2's virtual-shard default), **group commit as the only real answer to the Postgres ceiling** (grafted as B4), **O(nodes) coordination economics** (grafted as node-batched frontier closing), the zero-copy-shard-movement framing (already true in A's shared substrate — moving a shard between nodes is a lease move), and the intent journal / exactly-once retry idea (deferred, with its PII-retention problem named as the reason).
- **Design A itself** — wins only as amended, and the record should say so: its as-written §1.2 proof was falsified (live-lease exclusion), its §6 "closed at the store" claim did not cover the eviction path, and its §9 latency claim ("busy shards, ms") was wrong for any fleet with an idle shard. The verdict adopts A's skeleton *because* the critiques showed both flaws are repairable with mechanisms already in the design's own vocabulary — the lease row it already writes every commit, and the `nextval` monotonicity it already relies on — while its virtues (one line, scalar everything, zero migration, unchanged client, cross-shard subscriptions as literal prefix reads, the cheapest hardening-first slice) are the ones no rival could match.