# Design A — "One Line, Many Hands": Central-Order / Parallel-Execute Write Sharding for Stackbase

**Thesis.** The global monotonic bigint timestamp line is Stackbase's most valuable asset — it is what makes `StateVersion` a scalar, RYOW a scalar wait, `_creationTime` globally meaningful, the replica tailer a dumb loop, and (uniquely among every ancestor studied) cross-shard reactive subscriptions *possible at all*. So we do not fork it. We keep **one logical log and one global ts line**, serialize only the *cheapest possible thing* — timestamp issuance, via the Postgres sequence the commits already flow through — and let N shard writers execute and OCC-validate fully in parallel. Out-of-order visibility is solved by an explicit **closed-frontier protocol stored in Postgres itself** (store-is-the-coordinator, extending the shipped `fleet_lease` machinery), following the convergent pattern of FDB's sequencer, Kafka's LSO, Spanner's t_safe, and — most directly — Convex's own `max_repeatable_ts`, generalized from one committer's pipeline to N shard writers.

The result: mutations execute in parallel per shard with zero per-commit coordination beyond one `nextval()` folded into the commit's own Postgres transaction; every reader anywhere in the fleet reads at a provably stable prefix; the client protocol, RYOW, and `_creationTime` are **unchanged on the wire**; and a Tier-0 single binary runs identical app code byte-for-byte.

---

## 0. Design at a glance

```
                    ┌────────────────────────────────────────────┐
                    │            ONE shared Postgres              │
                    │  stackbase_ts  SEQUENCE  (the sequencer)    │
                    │  documents / indexes  (+ shard_id column)   │
                    │  shard_leases(shard_id, epoch, writer_url,  │
                    │               frontier_ts, expires_at)      │
                    └────────────────────────────────────────────┘
   commit txn (atomic):                         readers (all nodes):
   ts := nextval('stackbase_ts')                F := min(frontier_ts)
   INSERT rows @ ts                                  over LIVE leases
   UPDATE shard_leases SET frontier_ts=ts       tail (wm, F];  wm := F
     WHERE shard_id=$s AND epoch=$mine          serve queries/subs @ F
     (0 rows → zombie writer → abort)
```

- **Shard** = a *virtual shard*: `shardId = jumpHash(shardKeyValue) mod NUM_SHARDS` (config, default 8). All docs with the same shard-key value land on one shard → single-shard transactions per conversation/tenant, Vitess-keyspace-id style, never per-document hashing (concave's trap).
- **Writer-per-shard** = the shipped single-writer fleet design, run per shard: per-shard advisory lock + per-shard lease row + per-shard in-memory OCC ring. A node may hold several shard leases; every node keeps tailing the *whole* log into its local replica exactly as today.
- **Order is central, work is parallel** (FDB's exact split): the only serialized resource is Postgres sequence issuance, which handles millions/sec and costs ~nothing inside a transaction that was writing to Postgres anyway.

---

## 1. Timestamp & ordering protocol

### 1.1 Who allocates ts

**The shared Postgres sequence, called inside the commit's own transaction.** Today the transactor allocates `commitTs` from an in-memory oracle and then writes rows stamped with it. In fleet-sharded mode, `DocStore.write()` becomes *allocating*: the writer sends the write batch without a ts; the store's single commit transaction does

```sql
BEGIN;
SELECT nextval('stackbase_ts');            -- ts for this whole transaction
INSERT INTO documents (..., ts, shard_id) ...;   -- all rows stamped ts
INSERT INTO indexes   (..., ts, shard_id) ...;
UPDATE shard_leases SET frontier_ts = $ts, prev_ts = frontier_ts
  WHERE shard_id = $s AND epoch = $myEpoch;      -- 0 rows → ROLLBACK (fenced)
COMMIT;
```

and returns the ts to the transactor, which then pushes `{ts, writes}` into its per-shard `recentCommits` ring and `publishCommitted(ts)` — same discipline as today (`single-writer-transactor.ts` L225–228), per shard.

Why this beats a coordinator-hosted TSO service: **there is no separate allocation round trip and therefore no "allocated but not yet landed" window at all.** A ts becomes visible *atomically with its rows* — TiDB's lock-resolution problem and Kafka's open-transaction LSO bookkeeping vanish by construction. The out-of-order problem reduces to exactly the documented Postgres-outbox problem (commit order ≠ nextval order across concurrent transactions), which the frontier below closes.

Key ordering facts, each load-bearing:
1. `nextval` is globally monotonic in *issue* order; a value is never reused.
2. Each shard's writer serializes its commits under its per-shard mutex, so a shard's ts values are strictly increasing (allocation order = commit order *per shard* — the invariant the OCC ring needs, §2).
3. `prev_ts` chaining per shard (the `UPDATE` above copies the old frontier into `prev_ts`; each commit group also carries its shard-predecessor ts as a log column) makes per-shard prefix density **mechanically checkable** by any tailer — FDB's LSN chaining, turning the frontier from a convention into a verifiable invariant.

### 1.2 The closed-frontier rule (out-of-order visibility)

Per shard *s*, `frontier_ts(s)` in `shard_leases` means: **every commit of shard s with ts ≤ frontier_ts(s) is durably present in the log, and no future commit of s will ever land at ts ≤ frontier_ts(s)** (its next commit takes a fresh `nextval`, which is strictly greater; a deposed writer is fenced by the epoch predicate). This is Convex's `max_repeatable_ts` made per-shard, and CRDB's closed timestamp with "log position" replaced by "same-transaction atomicity."

**Global safe frontier:**

```
F = min over shards with a LIVE lease of frontier_ts(s)
```

**Claim:** every row with ts ≤ F is present, and no row will ever land at ts ≤ F.
*Proof sketch:* any row belongs to some shard s. If s has a live lease, frontier_ts(s) ≥ F, so s's prefix ≤ F is complete and s's future commits exceed frontier_ts(s) ≥ F. If s has no live lease, s cannot commit at all (every commit requires the epoch-matched lease-row update inside its own transaction; the promotion path in §6 guarantees no in-flight zombie transaction survives), so s contributes nothing ≤ F that isn't already there. ∎

**Idle-shard bump (mandatory — the trap Convex names explicitly):** an idle shard would pin F forever. Fix: the per-shard lease heartbeat (which already exists — leases heartbeat today) also runs `frontier_ts = nextval()` with no rows. Safe by fact (2): the writer's next real commit takes a later `nextval`. Cost: zero new periodic machinery — it rides the existing heartbeat, default interval **H = 200 ms** (CRDB's side-transport interval).

Frontier hygiene, verbatim from Convex's committer: bumps never run concurrently per shard (the writer's mutex gives this for free), and F consumers take `max(F_new, F_prev)` — **F never regresses** even under lease-set churn.

### 1.3 The exact reader rule

- **Single-shard readers** (a mutation's `ctx.db` on its home shard; per-shard RYOW): read at `lastCommitted(s)` on that shard's primary — the hot path pays **zero** cross-shard staleness.
- **Every global reader** — replica tailers, query/subscription snapshots, `StateVersion` advancement, cross-shard pagination cursors — reads at **F**, never at `maxTimestamp()`. `maxTimestamp()` is demoted to oracle-seed-only; a `StablePrefixTs` branded type (Convex's provenance-typed `RepeatableTimestamp`, in TypeScript) makes it a compile error to feed a raw log ts where a frontier is required.

### 1.4 Cost and staleness

- **Per-commit cost:** one `nextval` + one single-row `UPDATE`, both inside the commit transaction that already existed. No extra round trips, no writer↔writer messages, no coordinator RPC. Marginal cost ≈ 0.1 ms of Postgres work. Sequence contention is a non-issue (PG sequences are non-transactional counters; TiDB/FDB demonstrate 10⁶+/sec for this role).
- **Worst-case staleness of F:** `max(H, duration of the slowest in-flight commit transaction)` — under load, busy shards advance frontiers *per commit* (ms-scale); idle shards lag by ≤ H = 200 ms. A stuck commit transaction stalls F for its duration; commit transactions carry a `statement_timeout` (default 5 s) so the stall is bounded, and a writer that loses its lease drops out of the min entirely. Staleness degrades **latency, never correctness** (audit MUST-HOLD #1 is preserved: F is a gapless monotonically-closed prefix).

---

## 2. OCC and serializability

### 2.1 Per-shard: today's guarantees, verbatim

Each shard gets its own instance of exactly today's machinery: mutex, `recentCommits` ring, `activeSnapshots`, `snapshotTs = lastCommitted(s)`, conflict iff `c.ts > snapshotTs && reads.intersects(c.writes)`. Fact 1.1-(2) (per-shard ts strictly increasing in commit order) is precisely what the strict-`>` check needs; the audit's §1 table confirms every row of the transactor is safe under "one transactor per shard, transaction confined to the shard." **Full serializability within a shard, unchanged code path.** One document = one owning shard forever (shard key is immutable — enforced at kernel write time, §3.4 — so prev_ts chaining never crosses writers).

### 2.2 Cross-shard reads inside mutations — the honest policy

The locked decision (one transaction = one shard, cross-shard transactions rejected v1) is structural here: the OCC ring is process-local per shard, so a foreign read can never be conflict-checked. The design draws one pragmatic, clearly-documented line:

- **Reads/writes of the home shard's tables:** serializable, as above.
- **Reads of *global* tables** (tables without `.shardKey` — config, identities, reference data; they live on the default shard): **allowed, as frontier reads.** The mutation captures F once at transaction start and reads global tables *from the node's local replica* at F (every fleet node already tails the full log — the shipped replica is what makes this local and cheap). These reads are recorded in the read set (so subscriptions stay precise) but are **not OCC-validated**. The snapshot is split: `(home shard @ lastCommitted(s), global tables @ F)` — each half individually stable, so deterministic replay on OCC retry re-reads identically.
- **Reads of a *different sharded table's* foreign shard:** **rejected with a clear error** at runtime ("mutation on shard 3 cannot read `messages` row on shard 5; use an action with `ctx.runQuery`, or co-locate by sharing a shard key"). Citus-style co-location by shared key is the sanctioned pattern.

**Write-skew statement, plainly:** a shard-S mutation that reads a global table concurrently with a default-shard mutation writing it can exhibit write skew (e.g., read `quota.enabled = true` at F while it is being flipped). Serializability is per-shard; cross-shard mutation reads are "stable snapshot ≤ F" — the same anomaly class Lunora shipped silently; we ship it *documented*, with the error message for the sharded-table case pushing developers toward safe patterns. Cross-shard *invariants* (global uniqueness, cross-tenant quotas) cannot be enforced in a single mutation in v1 — that is what "cross-shard transactions rejected" means, and we say so in the docs rather than pretending.

### 2.3 Component co-commit (the audit's unstated constraint #10)

`ctx.scheduler.*` and the workflow journal write inside the caller's transaction, so **component tables are implicitly sharded by caller shard**: a scheduler job enqueued from a shard-3 mutation is a shard-3 row; the workflow started there keeps its `workflows`/`steps`/`events` rows on shard 3 (each transition is a read-then-write of those rows plus jobs — single-shard by construction; the `generationNumber` OCC guard is data-level and survives untouched). Each shard's lease holder runs one driver instance scoped to its shard's job partition (the recurring-driver seam already starts/stops drivers at promotion — parameterize by shard). Crons registered without a shard key run on the default shard, exactly as today.

---

## 3. Mutation routing DX

### 3.1 The public API

```ts
// convex/schema.ts — one edit makes a table sharded (the dormant API, now live)
export default defineSchema({
  channels: defineTable({ name: v.string() }),
  messages: defineTable({
    channelId: v.id("channels"),
    body: v.string(),
    authorId: v.id("users"),
  })
    .index("by_channel", ["channelId"])
    .shardKey("channelId"),                    // ← already in @stackbase/values
});
```

```ts
// convex/messages.ts — declare which arg names the shard
export const send = mutation({
  args: { channelId: v.id("channels"), body: v.string() },
  shard: "channelId",                          // shorthand: named arg
  // or: shard: (args) => args.channelId,      // resolver form for derived keys
  handler: async (ctx, { channelId, body }) => {
    const author = await ctx.auth.getUserIdentity();     // global table: frontier read, fine
    await ctx.db.insert("messages", { channelId, body, authorId: author._id });
  },
});
```

```ts
// client — completely unchanged, shard-oblivious
await client.mutation(api.messages.send, { channelId, body: "hi" });
const messages = useQuery(api.messages.list, { channelId }); // queries never declare shards
```

### 3.2 Routing mechanics

Resolution happens **server-side, pre-execution, at the existing `WriteRouter` chokepoint** (`runtime.ts:152–154` — already consulted by every mutation/action entry before local execution, already fleet-proven via `forwarder.ts`): `shardId = jumpConsistentHash(encode(shardKeyValue)) mod NUM_SHARDS` via the existing `ShardKeyResolver`; look up `shard_leases[shardId].writer_url`; forward over the existing `/_fleet/run` (now returning `{shardId, commitTs}`). Because the *server* resolves the shard from validated args, Lunora's entire `authorizeShard`/`FORBIDDEN_SHARD` security surface never exists — the client cannot name a shard.

### 3.3 Tier-0 and the un-sharded

- **Tier-0 single binary / plain `stackbase serve`:** `NUM_SHARDS = 1`, one process holds the only lease, the router resolves everything to local, allocation stays on the in-memory oracle, frontier machinery is dormant. **Byte-for-byte today's behavior; identical app code; `shard:` is an inert annotation** — exactly how single-node Citus/VoltDB behaves (audit MUST-HOLD #12).
- **Un-sharded tables and mutations without `shard:`** route to the default shard — today's semantics, forever. Apps that never call `.shardKey()` never observe sharding.

### 3.4 Enforcement (closing Lunora's convention hole)

At kernel write time, every insert/replace into a table with a `.shardKey` has its key field resolved and compared to the transaction's home shard; mismatch → hard error naming the fix ("`messages` is sharded by `channelId`; this mutation runs on shard 3 but the document belongs to shard 5 — add `shard: "channelId"` or check your key"). The shard-key field is immutable after insert (preserves one-owner-forever, audit MUST-HOLD #3). A mutation with no `shard:` that writes a sharded table errors at the first such write with the same guidance. Resharding NUM_SHARDS is a v1 non-goal (documented: pick a power of two up front; splitting is future work with the jump-hash chosen to minimize movement).

---

## 4. Cross-shard reactive subscriptions — the headline

This is where central-order wins outright, and where every ancestor failed (Lunora: per-shard-only live queries, poll-and-diff fallback; Convex: never sharded; concave: never built it). Because there is **one log and one line**, and every sync node already tails the whole log:

- **Nothing about subscription evaluation changes.** A subscribed query — spanning any number of shards — runs on a sync node against its local replica at the node's current F. F is a stable prefix of the single global line, so **every re-run is a consistent cross-shard snapshot**; there is no "stitched" state, no per-shard version vector, no torn read, ever.
- **Invalidation is already shard-agnostic** (audit seam #7: `subscription-manager.ts` is pure byte-range intersection keyed by `(tableId, index)`). Deltas from all shards arrive through the same tail; the only wire fix is threading `shardId` through `EmbeddedWriteFanoutPayload` (the one concrete gap the audit found at `write-fanout.ts:11–16`).
- **`StateVersion.ts` stays a scalar:** the node's F at Transition-emission time, monotone per node (max-with-previous). The client reducer's equality-bracket/resync logic (`client-reducer.ts:38–41`) is untouched; the deferred version-gap-resync optimization remains *possible* because "everything ≤ ts is reflected" stays literally true — it's F.
- Interleaved arrival of different shards' deltas can trigger back-to-back re-runs (audit MAY-RELAX #6): extra recomputation, never wrongness, and epoch-quantized notify coalescing (Calvin-style, 5–20 ms ticks on the sync node) bounds it under load.
- Cross-shard **pagination** also survives scalar: cursors are `(indexKey, _id)` at an MVCC snapshot; the snapshot is F, valid across shards because F is globally stable.

---

## 5. Replica tailer + RYOW

**Tailer** (`replica-tailer.ts:207–262`, the audit's single hardest site): the fix is one substitution — `newMax = F` instead of `primary.maxTimestamp()`. Pull `(wm, F]`, apply verbatim, `wm := F`. By the §1.2 claim, this window is provably complete and nothing will ever land inside it later — **the skipped-ts-99 bug is structurally dead**, not patched. One-ts-per-transaction grouping survives unchanged (one `nextval` per commit, globally unique). The additive `shard_id` column plus per-shard `prev_ts` chains let the tailer *assert* density per shard and crash loudly on violation instead of corrupting silently.

**RYOW:** `/_fleet/run` returns `{shardId, commitTs}`; commitTs is on the one global line, and the replica watermark *is* F, so today's scalar wait — `tailer.waitFor(commitTs)` — **remains correct with zero protocol change**. Honest cost: the wait now clears only when *every* shard's frontier passes commitTs, adding up to ~H (200 ms) when other shards are idle. Optimization (slice 3): the tailer additionally tracks per-shard applied frontiers and `waitFor(shardId, ts)` clears on the home shard alone — sub-frontier RYOW with the scalar path as the always-correct fallback. Action `maxCommitTs` folding (`executor.ts:283–292`) stays a scalar max for the same reason.

---

## 6. Failover, per shard

Direct parameterization of the shipped machinery — no new concepts:

- `fleet_lease` (one row, `id = 1`) → **`shard_leases`** keyed by `shard_id`, each row carrying `epoch`, `writer_url`, `expires_at`, `frontier_ts`, `prev_ts`. The lease row and the frontier row are the *same row* — heartbeat and frontier bump are one `UPDATE`.
- Per-shard advisory lock key = `hashint8('stackbase_shard' || shard_id)` — same primitive as today's writer lock.
- **Promotion** = today's 7-step order (`node.ts:426–434`) run for one shard: acquire the shard's advisory lock (unobtainable while the old writer's session lives → no split brain; session death aborts its in-flight commit transactions and releases the lock atomically — Postgres gives us the fence), bump `epoch`, point the shard's `SwitchableDocStore`, start the shard's drivers. **No `observeTimestamp(maxTimestamp())` seeding needed for ordering** — the global sequence self-fences: the new writer's first commit takes a `nextval` greater than everything ever issued, and the old writer's straggler commit dies on the epoch predicate *inside its own transaction* (the audit's promotion-fencing hole at `node.ts:426` is closed at the store, not by heuristics).
- Lease epoch doubles as Lunora's timeline-epoch lesson: any per-shard cursor/`prev_ts` chain is implicitly paired with the epoch that wrote it.
- **Placement:** every node runs a `ShardLeaseBalancer`: try to hold `ceil(NUM_SHARDS / liveNodes)` leases, acquire unheld ones, shed excess on a jittered timer. A node is writer-for-a-set, sync-for-the-rest (`role()` becomes per-shard). A dead node's shards are picked up shard-by-shard within one lease TTL; during the gap that shard's writes queue/fail-fast at the forwarder while **reads and all other shards are unaffected**, and F excludes the dead shard's frontier (live-lease rule) so fleet visibility keeps advancing.

---

## 7. Deploy-anywhere check

- **Postgres-only, vanilla:** one sequence, one small table, advisory locks, NOTIFY — all already in the shipped fleet's dependency set. No Redis/etcd/clock hardware (Spanner commit-wait and HLC fleets explicitly rejected — NTP ε would be a 100 ms+ tax and breaks the one-bigint invariant every subsystem assumes).
- **Self-host:** `stackbase serve --fleet --shards 8` on N identical processes; same Docker story; Tier-0/SQLite untouched.
- **Object-storage future:** because visibility is **explicit frontier rows** rather than Postgres-snapshot magic (we deliberately did *not* build on `xid8`/`pg_snapshot_xmin`, which is kept only as a belt-and-suspenders assertion in the tailer), the protocol ports: per-shard segment logs as appended objects, a per-shard frontier manifest object (CAS-updated with the epoch as fence), readers computing `F = min(manifests)`. The sequencer is the one piece needing a home there — a coordinator-lease-held ts-range grantor (the TiDB window trick: persist `high_water = granted + 2²⁰` per window) slots into the same seam, which is why `DocStore.write`'s "store allocates ts" contract is written substrate-agnostically from day one.

---

## 8. Incremental build path from the shipped fleet

**Slice 1 — frontier plumbing on ONE shard (ships alone, immediately valuable):** move ts allocation into the commit transaction (`nextval` + store-returns-ts contract change); create `shard_leases` with the single `"default"` row absorbing `fleet_lease`; epoch-fenced commit UPDATE; tailer pulls `(wm, F]`; `StablePrefixTs` branded type; thread `shardId` through the fanout payload and the `shard_id` column through both stores (additive migrations). Behavior-identical with one shard, but the entire "all ts ≤ X present" bug class and the promotion-fencing hole are structurally closed — a hardening slice worth merging even if sharding stopped here. E2E: the existing fleet tests must pass unmodified.

**Slice 2 — N static shards:** `--shards N`; `ShardKeyResolver` live in the `WriteRouter`; `mutation({shard})` API + codegen; kernel shard-ownership write guard; per-shard transactor instances + leases + promotion + balancer; per-shard driver partitions for scheduler/workflow; frontier-read path for global tables. E2E through real `stackbase serve --fleet`: two writers on different shards committing concurrently, a cross-shard subscription opened before the writes seeing both, RYOW across a forwarded write, kill-a-writer failover for one shard while the other keeps committing.

**Slice 3 — polish:** per-shard RYOW waits, notify coalescing ticks, dashboard shard view, `pg_partman`-style log partitioning by `shard_id`, forwarder retry-during-failover.

---

## 9. Performance model

- **Scaling curve:** write throughput ≈ linear in shard count while the bottleneck is what it is today — the single writer process's JS execution + OCC + apply loop (order 1–5 k mutations/s/process). 8 shards on 4 nodes ≈ 8× commit parallelism. The curve flattens when the **shared Postgres instance's transaction/fsync bandwidth** becomes the binding constraint (order 10–50 k small commit txns/s on decent hardware; per-shard group-commit batching, which the per-shard mutex makes natural, multiplies effective mutations per PG txn). Sequence issuance and frontier updates never bind (≪ PG's ceiling).
- **Added commit latency:** ≈ 0 vs the shipped fleet — the sequencer call and frontier UPDATE ride the existing commit round trip. Forwarded-write latency unchanged (same `/_fleet/run` hop).
- **Visibility latency:** busy shards, ms (frontier advances per commit); idle shards bound F lag at H = 200 ms; RYOW hot path per-shard-optimized to today's numbers.
- **The bottleneck that remains, stated plainly:** one Postgres. This design removes the *compute/serialization* ceiling and keeps the *durability-bandwidth* ceiling. That is the deliberate trade of central-order: Tier 2 stays "N processes, one database, zero new infra"; splitting the log itself across databases/object storage is Tier 3, and the explicit-frontier protocol is the piece of this design that survives into it unchanged.

---

## 10. Weaknesses — the three worst, named by the author

1. **One Postgres is still the write ceiling.** All shards fsync into the same instance; I parallelized execution, not durability. An app that outgrows ~tens of thousands of commit transactions/sec outgrows this design, and the honest answer is "that's Tier 3." A critic can fairly say the headline "removes the write ceiling" really means "moves it from ~2 k/s to PG's limit."
2. **Min-frontier coupling: the fleet's visibility is hostage to its worst shard.** One writer with a long commit transaction, a GC pause spanning heartbeats, or lease flapping drags F — stalling *every* cross-shard subscription re-run, scalar RYOW wait, and replica watermark fleet-wide, up to the statement-timeout/lease-TTL bound (seconds). It degrades staleness not correctness, but "one hot shard makes everyone's reactivity jittery" is a real operational sharp edge, and the per-shard-wait optimization only rescues RYOW, not subscriptions.
3. **Un-checked cross-shard reads are a new, silent anomaly class.** Frontier reads of global tables inside mutations are not OCC-validated: write skew that today's engine *cannot* exhibit becomes possible, and the failure mode (a stale-by-≤F read of a config/limits row) is exactly the kind developers won't test for. The mitigation is documentation plus hard errors on the sharded-foreign-read case — a linguistic fence, not a mechanical one; a critic should press hardest here, and on the adjacent DX cliff that cross-shard *invariants* (uniqueness, quotas) simply cannot be expressed in one mutation in v1.

(Honorable mentions the critic will also find: `NUM_SHARDS` is fixed at deploy time — resharding/splitting is future work; the store-allocates-ts contract change is the most invasive diff to the transactor/docstore seam in the whole design; and `_creationTime` = snapshot-ts means creation order can slightly trail commit order across shards — observable, mild, and unchanged from today's single-line semantics otherwise.)