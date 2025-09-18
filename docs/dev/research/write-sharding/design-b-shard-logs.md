# Design B-shard-logs: Per-Shard Logs, Frontier Versions

**Thesis.** Stop pretending there is one timeline. Give each shard group its own monotonic ts line, its own single writer, its own append-only log, and its own OCC ring — a full copy of today's proven single-writer engine, instantiated P times over one shared Postgres. The write path has **zero cross-shard coordination**: no shared sequence, no TSO, no min-over-writers frontier that a slow shard can stall. All the new machinery lives on the read side, where it belongs: readers hold a **bounded frontier vector** (one watermark per shard *group*, P entries, not per key), and the vector is provably a consistent cut because cross-shard transactions do not exist. This is the Lunora/Durable-Objects shape (the only ancestor that shipped write sharding) rebuilt on a portable substrate, plus the one thing no ancestor ever built: live cross-shard subscriptions via Stackbase's range-intersection invalidation.

The killer structural fact this design exploits: **because every transaction reads and writes exactly one shard (locked decision), every commit is a single-group event. Any vector of per-group closed frontiers is therefore a consistent cut of the true history** — there is no multi-group atomic write whose halves could be torn. The global-timestamp alternative spends real coordination to maintain a total order that nothing in the system semantically requires; this design deletes the requirement instead of paying for it.

---

## 0. Vocabulary and topology

- **Logical shard** = a shard-key *value* ("conversation = shard", locked). Millions of these.
- **Shard group** (just "group" below) = a physical write domain: one ts line, one log partition, one lease, one in-process transactor. `hash(shardKeyValue) mod P` maps logical shards onto groups. **P is small and fixed at deploy time** (`--shards 8`, default 1). Group `0` is always `"default"` and holds every unsharded table.
- **Frontier vector** `W = [W_0..W_{P-1}]` = per-group closed watermarks. P-bounded — this is what makes "vector-ish" cheap: 8–64 bigints, not one per conversation.
- Fleet stays **symmetric** (per `tier2-topology-research.md`): every node runs the same binary, tails **all** groups into its local SQLite replica, and *additionally* holds writer leases for zero or more groups. `role()` becomes a set, not a binary.

Existing seams consumed: `.shardKey(field)` (`values/schema.ts:97`), `OplogDelta.shardId`/`DocStore.write(shardId)` (typed end-to-end, currently dropped), `TimestampOracle` (doc comment already says "one per shard", `docstore/types.ts:137`), `WriteRouter.forward` (`runtime.ts:152` — the pre-execution chokepoint), the lease/promotion machinery (`ee/packages/fleet/src/lease.ts`, `node.ts:426–434`), `SwitchableDocStore`.

---

## 1. Timestamp / ordering protocol

**Who allocates.** The group's lease-holding writer, in-process, from `oracle_g` — exactly today's `single-writer-transactor.ts` allocation (`allocateTimestamp()` under the mutex, L182/206), replicated per group. No Postgres sequence, no TSO, no batched grants, no RPC. Allocation order ≡ commit order ≡ visibility order *within a group*, preserved by the same per-group mutex discipline that guarantees it today (`L225–228`: push to ring, then `publishCommitted`, apply-before-publish).

**Out-of-order visibility.** Does not exist within a group (one writer, serial under mutex, no pipelining in v1 — same as today). Does not exist *across* groups because there is no cross-group order to violate. The "A commits ts 101 before B's in-flight 99" problem is dissolved, not solved: 101 and 99 are on different lines and no reader ever compares them.

**The closed-frontier rule (exact).** The durable authority for group g's frontier is a column on the lease row, updated **inside the commit's own Postgres transaction**:

```sql
-- inside every commit transaction for group g, after the log appends:
UPDATE shard_lease
   SET last_commit_ts = $commitTs
 WHERE shard_id = $g AND epoch = $myEpoch;
-- 0 rows updated → I am fenced (deposed writer) → abort the whole PG transaction.
```

One statement, one indexed single-row update, riding a transaction that was already open. It does three jobs at once: publishes the frontier, fences deposed writers (§6), and — by PG atomicity plus the per-group mutex — guarantees the invariant readers need:

> **Reader rule:** every log row of group g with `ts ≤ shard_lease[g].last_commit_ts` is durably present, dense, and immutable. A replica that has applied group g through `W_g ≤ last_commit_ts[g]` may serve any read of group g at any `ts ≤ W_g`.

No min-over-in-flight bookkeeping, no `pg_snapshot_xmin` scans, no allocated-ts leases to expire — those are all costs of multiplexing writers onto one line, which we don't do. `RepeatableTimestamp`-style provenance typing (Convex's lesson) is kept: a `ClosedFrontier` branded type is the only thing `DocStore.get/index_scan` accept, constructed only from `shard_lease` reads or applied-replica watermarks.

**Per-commit cost:** zero extra round trips, one extra row in the write batch. **Worst-case staleness:** for readers of group g, exactly today's replication lag for that group (NOTIFY + 1s poll), *uncoupled* from every other group — an idle or stalled group never delays anyone else's visibility. (Contrast: any global-line design has a fleet-wide frontier = min over writers, where one slow commit stalls *all* replicas; that failure mode is structurally absent here.)

**The `_creationTime` prerequisite (slice 0).** The audit's second decisive site: `kernel.ts:172` sets `_creationTime = Number(snapshotTs)`, and `index-manager.ts:23–32` bakes it into every index key and cursor. Per-group lines make raw-ts `_creationTime` cross-shard-incomparable garbage. So **before forking the line**, `_creationTime` becomes what Convex actually ships: wall-clock ms with a per-writer logical tiebreak (monotone per group, `max(now, last+ε)`), decoupled from the commit ts. `_id` keeps index keys globally unique (unchanged). Consequences owned honestly: cross-group `by_creation_time` order becomes exact-per-group / clock-skew-approximate across groups (NTP-bounded, ms scale); within a group it stays exact. This is a Convex-parity *fix* worth shipping standalone.

---

## 2. OCC and serializability

**Per group: full serializability, byte-for-byte today's algorithm.** Each group has its own `mutex`, `recentCommits` ring, `activeSnapshots`, and snapshot rule `snapshotTs_g = oracle_g.getLastCommittedTimestamp()`. The conflict check `c.ts > snapshotTs && reads ∩ c.writes` (`single-writer-transactor.ts:199–203`) is exactly as sound per group as it is today globally, because the group writer is the sole writer of everything the transaction reads and writes on that group. prev_ts chaining (L214) holds via "one document = one owning group, forever" (hash of its shard-key value; documents cannot change their shard-key field — enforced at `handleDbReplace`, an instructive error, same class as Convex's immutable `_id`).

**Cross-shard reads inside mutations — the policy, stated plainly:**

1. A mutation's **writes** are confined to its resolved group. Writing a sharded table and a differently-grouped table in one mutation throws at commit with an instructive error naming both groups. (Component tables don't hit this — see below.)
2. Reads of the **default group** (unsharded tables: config, feature flags, identities) are allowed from any mutation, served from the executing writer node's local replica at its closed frontier `W_0`. These are **frozen reads**: recorded in the read-set for *subscription invalidation*, but **not OCC-validated** — group 0's ring never sees them.
3. Reads of *other sharded groups* are **denied by default** (throw: "mutation on shard group 3 read `messages` on group 5 — cross-shard reads in mutations are frozen, not serializable; opt in with `crossShardReads: true` or restructure so the invariant is shard-local"). The opt-in unlocks the same frozen-read semantics as (2).

**Write-skew, honestly:** two concurrent mutations on groups A and B that each frozen-read the other's group and write their own do not serialize against each other — the classic anomaly, permanent by construction (cross-shard transactions rejected v1, locked). Staleness of a frozen read = local replica lag of that foreign group (typically <1s; the writer node is also a sync node tailing everything). The DX stance is that of Citus/Vitess/Lunora, but *louder*: the anomaly is opt-in per mutation, named in the error message, and documented with the rule of thumb "an invariant you'd protect with a transaction must live inside one shard key — that is what `.shardKey` means." Queries (pure, read-only) are exempt: they freely span groups (§4) because a frontier-vector read is a consistent cut and there is nothing to skew.

**Component co-commit (audit MUST-HOLD #10).** `ctx.scheduler.runAfter` and the workflow journal write inside the caller's transaction (`facade.ts:214–241`), so component tables are **sharded by caller**: a job enqueued by a shard-group-g mutation is a group-g row (`shard_id = g` on the jobs row). Each group's lease holder runs its own scheduler/reaper driver instance over its group's partition (the driver seam already starts/stops with the writer role — `node.ts:433 startDrivers` parameterizes by g). A workflow is pinned to the group where `ctx.workflow.start` ran; its `workflows`/`steps`/`events` rows and all its scheduler jobs stay group-local, so the `generationNumber` OCC guard is untouched. Crons and global singletons run on group 0.

---

## 3. Mutation routing DX

The shard is resolved **server-side, from args, before execution**, at the existing `WriteRouter.forward(kind, path, args, identity)` chokepoint — the client never names a shard, so Lunora's entire `authorizeShard` attack surface never exists.

```ts
// convex/schema.ts — one edit makes a table sharded
export default defineSchema({
  channels: defineTable({ name: v.string(), ownerId: v.id("users") }),
  messages: defineTable({
    channelId: v.id("channels"),
    body: v.string(),
  })
    .index("by_channel", ["channelId", "_creationTime"])
    .shardKey("channelId"),          // ← already in the schema API today
  reactions: defineTable({
    channelId: v.id("channels"),     // same key space ⇒ co-located with messages
    messageId: v.id("messages"),
    emoji: v.string(),
  }).shardKey("channelId"),
});
```

```ts
// convex/messages.ts
export const send = mutation({
  args: { channelId: v.id("channels"), body: v.string() },
  shardBy: "channelId",              // name a validated arg — or (args) => args.channelId
  handler: async (ctx, { channelId, body }) => {
    await ctx.db.insert("messages", { channelId, body });     // group g = hash(channelId) mod P
    await ctx.db.insert("reactions", { channelId, messageId, emoji: "🎉" }); // same group: fine
    const cfg = await ctx.db.query("appConfig").first();       // default-group frozen read: fine
    await ctx.scheduler.runAfter(0, internal.push.notify, {}); // job row lands on group g: fine
  },
});
```

```ts
// client — completely unchanged, shard-blind
await client.mutation(api.messages.send, { channelId, body: "hi" });
const msgs = useQuery(api.messages.list, { channelId });
```

Routing pipeline: `WriteRouter` looks up `shardBy` from the function's metadata (codegen emits it; validators guarantee the arg exists and is typed — a `shardBy` naming a missing/optional arg is a *codegen-time* error), computes `g = jumpHash(canonicalBytes(value), P)`, consults `shard_lease[g].writer_url`, and forwards over the existing `/_fleet/run` (now carrying `shardGroup` and returning `{shardId, commitTs}`). Mutations **without** `shardBy` that write only unsharded tables route to group 0; a `shardBy`-less mutation that writes a sharded table throws at write time with the fix spelled out. `ctx.db.insert` on a sharded table cross-checks that the row's shard-key field hashes to the executing group — the write-path guard Lunora skipped (their shard key was an unverified addressing convention; ours is enforced data).

**Tier-0 / un-sharded deployments:** without `--shards`, P = 1 — every table, every mutation, every code path is group `"default"`, and the audit's MUST-HOLD #12 is satisfied *literally*: one oracle, one ring, one log, one lease row; `shardBy` resolves to the only group and is a no-op annotation. The identical app code runs on the single binary, `stackbase dev`, a 1-writer fleet, and a P=16 fleet. Same-code-at-every-tier is not a compatibility layer; it is the degenerate case of the design.

---

## 4. Cross-shard reactive subscriptions — the piece no ancestor built

Every sync node tails **all P group logs** into its local replica (§5), so any query — sharded, unsharded, or spanning — executes locally on one node. Mechanics:

1. **Snapshot = frontier vector.** At query start the node captures `W = (W_0..W_{P-1})` from its applied watermarks. `DocStore.get/index_scan` take a `ClosedFrontier` (scalar at P=1, vector otherwise); a scan over a sharded table's index filters each revision by `ts ≤ W[row.shard_id]`. MVCC revisions in the replica make this repeatable while the tailer keeps applying underneath.
2. **Why it's consistent.** Every commit is single-group (§0), so *any* frontier vector is a consistent cut: no visible write can depend on an invisible one through the database itself. The read is never torn — the failure mode Lunora's fan-out (N unrelated snapshots) silently accepts is structurally excluded.
3. **Read sets** are recorded exactly as today — range-precise, and already shard-agnostic (`subscription-manager.ts:88–102` is pure byte-range intersection). The subscription additionally records the **set of groups its ranges touch**: a `by_channel`-prefixed query touches one group; an unprefixed full-table scan touches all P. This is the "bounded vector" promise: a subscription tracks 1 frontier in the common case, P in the worst, never one-per-conversation.
4. **Invalidation.** The commit fan-out payload gains `shardId` (fixing the `write-fanout.ts:11–16` drop — the audit's "first concrete wire gap"). On a delta from group g whose ranges intersect the read set, the node waits until its local `W_g ≥ delta.ts`, then re-runs at a **fresh full vector** and pushes a Transition. Deltas from different groups arriving interleaved cause at worst an extra re-run, never wrongness (audit MAY-RELAX #6) — each re-run is itself a consistent cut.
5. **`StateVersion` redefinition (audit MAY-RELAX #3).** `StateVersion.ts` becomes a **node-local monotonic transition sequence** rather than a commit ts. The client is provably indifferent today — `client-reducer.ts:38–41` does equality-only bracket matching and resyncs on any gap — so the wire shape, the reducer, and resync-on-gap survive unchanged. The forfeited item is the *deferred* ts-based version-gap resync optimization across node reconnects (a reconnecting client full-resyncs, exactly as it does today). RYOW tokens travel separately as `(shardId, commitTs)` pairs (§5).
6. **Cross-group causality, honestly.** Groups are causally independent through the database; the app can create cross-group causality (mutate B after reading A). A subscription could transiently show the B-effect before the A-cause if the node's replica of B is ahead of A. The design's answer is **per-session monotonic frontiers**: each session tracks the max vector it has been served; RYOW waits (§5) fold committed writes into it; a query re-run never uses a vector below the session's floor. Within one session, causes a client itself created are never inverted; across sessions, ordering is eventual with lag-bounded skew. This is stated in the docs as the consistency contract: *serializable per shard, consistent-cut reads across shards, causal per session, eventual across sessions.*
7. **Pagination.** Cursors stay `(indexKey, _id)` raw key bytes — snapshot-independent, so they survive frontier advancement across pages exactly as they survive fresh snapshots today. Cross-group `by_creation_time` pagination becomes a P-way streaming merge on the (now wall-clock) `_creationTime` key — exact per group, skew-fuzzed across groups (§1), which the docs state.

---

## 5. Replica tailer + read-your-own-writes

**Log gains a shard dimension.** Additive `shard_id TEXT NOT NULL DEFAULT 'default'` on `documents` and `indexes`, plus index `(shard_id, ts)`; both stores stop dropping the `shardId` they already accept (`postgres-docstore.ts:124`, `sqlite-docstore.ts:96`). The PG store is physically schemaless for *app* data, so this is one internal DDL, not a migration regime.

**Tailer = P instances of today's algorithm, each on a provably-dense line.** Per group: `wm_g` = replica's max applied ts for g; pull `(wm_g, F_g]` where **`F_g = shard_lease[g].last_commit_ts`** — the published frontier replaces `primary.maxTimestamp()` as the pull bound, which repairs the audit's single hardest site (`replica-tailer.ts:207–262`) *by construction*: one writer per group, committing in ts order, with the frontier updated in the same PG transaction as the appends, means everything `≤ F_g` is present the moment `F_g` is readable. No skipped-ts-99 is possible on any line. Atomic ts-group application becomes `(shard_id, ts)`-group application (one transaction = one `(g, ts)` — audit MUST-HOLD #4). NOTIFY payloads carry `(g, ts)`; the 1s poll sweeps all groups. A slow group lags *its own* watermark only.

**No timeline forks on failover** — a structural win over Lunora's epoch-UUID re-seed dance: the log lives in shared Postgres and is never reset, and a new writer seeds `oracle_g` above `maxTimestamp(g)` while the fence (§6) guarantees no deposed-writer straggler lands below that. Replica cursors remain valid across failover with zero resync. Epochs exist for fencing writers, not for resetting readers.

**RYOW.** `/_fleet/run` returns `{shardId, commitTs}` (was one stringified scalar, `forwarder.ts:104`); the caller waits `tailer.waitFor(shardId, commitTs)` on its local replica. Action contexts fold inner commits into a **frontier map** `{shardId → maxCommitTs}` instead of the scalar `maxCommitTs` (`executor.ts:283–292`). Sessions keep a high-water frontier map; queries touching group g wait for `W_g ≥ session[g]` — YugabyteDB's "reader waits for safe time," which is precisely the shipped RYOW wait, per-shard. Waits are per-group, so a laggy group delays only reads that touch it.

---

## 6. Failover, per group

`fleet_lease` generalizes to:

```sql
CREATE TABLE shard_lease (
  shard_id       TEXT PRIMARY KEY,     -- 'default', 'g1', … 'g{P-1}'
  epoch          BIGINT NOT NULL,
  writer_url     TEXT NOT NULL,
  acquired_at    TIMESTAMPTZ NOT NULL,
  last_commit_ts BIGINT NOT NULL DEFAULT 0   -- the durable closed frontier (§1)
);
```

Mutual exclusion: one advisory lock per group (`pg_try_advisory_lock(STACKBASE_NS, hash(shard_id))` — the same primitive, keyed). Every node runs a jittered acquire loop over currently-unheld groups; a node may hold several leases (natural packing on small fleets; jitter spreads groups across nodes on large ones — no placement service, honoring the "store is its own coordinator" lock-in). Promotion is today's 7-step sequence (`node.ts:426–434`) parameterized by g: acquire lock_g → `observeTimestamp(maxTimestamp(g))` → bump `shard_lease[g].epoch` → swap in transactor_g via `SwitchableDocStore` → start group-g drivers (scheduler partition, reaper) → advertise → serve. Writer self-exits the *group role* on lease-g loss, keeping its sync role and any other leases.

**Fencing** is the §1 conditional frontier UPDATE: a deposed writer's in-flight commit transaction matches 0 rows on the stale epoch and the whole PG transaction aborts — the store-level epoch fence the audit demands (MUST-HOLD #5), closing the `maxTimestamp()`-can't-see-in-flight hole with no extra machinery.

**Blast radius:** group g's writer dying stalls writes to g for ~lease-TTL; the other P−1 groups take writes throughout; reads of g keep serving everywhere at the last frontier. This per-group isolation is the cleanest failure story any of the candidate designs can offer — there is no shared allocator or global frontier whose failure is fleet-wide.

---

## 7. Deploy-anywhere check

- **Postgres-only, no new infra:** the entire protocol is `shard_lease` rows + per-key advisory locks + one additive column — core-Postgres features available on every managed provider. No Redis/etcd/clock hardware; explicitly rejects TSO services and commit-wait (evidence report 1's rejections).
- **Self-host:** `stackbase serve --fleet --shards 8` on N boxes + one Postgres. Same Docker story.
- **Tier-0 / SQLite:** P=1 is a code path *identity*, not an emulation.
- **Object-storage future — where this bias shines:** a per-group log maps one-to-one onto the easiest object-storage primitive that exists: **one append stream per group with a single writer, plus one frontier-pointer object updated by conditional PUT** (S3 `If-Match` now ships; the conditional PUT *is* the epoch fence, replacing the advisory lock). Readers poll P pointer objects. A global-line design on object storage would need cross-stream coordination for its min-frontier — per-shard logs need literally none. The substrate swap is a `DocStore`+lease-seam implementation, not a protocol change.

---

## 8. Incremental build path from the shipped fleet

- **Slice 0 — `_creationTime` decoupling** (standalone Convex-parity fix; unblocks everything): wall-clock+tiebreak allocation in `kernel.ts`, docs note on cross-deploy semantics. Ship gate: conformance suite + index-key uniqueness property tests.
- **Slice 1 — shard dimension at P=1, behavior-identical:** `shard_id` column; stores stop dropping `shardId`; fan-out payload carries it; `/_fleet/run` returns `{shardId, commitTs}`; `waitFor(shardId, ts)`; `fleet_lease` → `shard_lease` (one row `'default'`); frontier published via the fenced UPDATE and the tailer pulls `(wm, F]` instead of `(wm, maxTimestamp()]`. Every byte of behavior identical; the fenced-frontier pull is a hardening win *on the shipped fleet by itself*. Ship gate: existing fleet E2E green, plus a new deposed-writer-straggler test.
- **Slice 2 — multi-group in one process:** P transactors/oracles/rings behind the router; `shardBy` resolution at `WriteRouter`; sharded-write guards; component-table partitioning + per-group drivers; frontier-vector reads in the query engine. Proves routing, per-group OCC, and consistent-cut reads with zero distribution risk (Tier-0, P=4, one process holding all leases). Ship gate: conformance suite at P=4 + a cross-group subscription E2E through real `stackbase dev`.
- **Slice 3 — fleet multi-writer:** per-group acquire loops and promotion, per-group tailer sub-tails, RYOW frontier maps, session monotonic floors. Ship gate: E2E through real `stackbase serve --fleet` — two writer nodes, concurrent writes to two groups, a subscription spanning both staying live and never torn, kill-a-writer failover isolating to one group.
- **Slice 4 — polish:** dashboard shard observability (per-group frontier/lag/lease view), skew diagnostics, docs consistency contract.
- **Explicitly deferred:** changing P (slot migration with revision-chain moves — the Vitess-resharding analogue), cross-shard mutation reads beyond frozen-default, per-group physical database separation.

---

## 9. Performance model

- **Write throughput:** ~linear in P for well-distributed keys — total ≈ P × today's single-writer rate, since groups share nothing on the write path (no allocator RPC, no frontier min, disjoint mutexes, disjoint rings). VoltDB validates the per-partition serial-writer model at 100k+ TPS/partition; our per-group ceiling is today's measured single-writer rate, unchanged.
- **Added latency per commit:** ~0. One extra single-row UPDATE inside the already-open commit transaction; no new round trips, no commit-wait, no batching delay. Forwarding cost is the shipped `/_fleet/run` hop, unchanged.
- **Read-side overhead:** P watermarks per node, a `shard_id` filter per scan, and a P-way merge only for cross-group ordered pagination. Subscriptions touching one group (the overwhelmingly common shape — that's what shard keys are *for*) pay one frontier comparison.
- **The bottleneck that remains, named:** the **one shared Postgres instance** — all P groups' commit transactions land on the same WAL/fsync/IOPS budget. This design scales the *writer processes* (JS execution, OCC, syscall work — today's actual ceiling); it does not scale storage bandwidth. When Postgres saturates, the escape hatch is native to this bias: per-group logs are already independent streams, so groups can be spread across physical databases (or the object-storage substrate) with **zero protocol change** — something a single-global-line design cannot do without redesigning its allocator. Second residual: a single hot shard key still caps at one group's throughput (inherent to every shard-key system in the evidence).

---

## 10. Weaknesses — the three worst, named by the author

1. **The consistency contract is permanently weaker across shards, and it's app-visible.** No cross-shard snapshot point exists — only consistent cuts. Frozen reads in mutations admit write-skew; cross-group invariants ("sum across channels ≤ quota") cannot be transactionally enforced, ever, and no future slice fixes this without reversing the locked cross-shard-transaction rejection. A subtle-bug class (developer assumes config-read is serialized with their write) is created and can only be mitigated by errors, docs, and the default-deny — not eliminated. The global-line rival design can honestly claim a stronger story here; this design trades it away and must say so on the tin.
2. **`_creationTime` semantics change is a breaking, schema-visible fork — and it's a prerequisite, not an option.** Every existing deployment's `_creationTime` (currently the logical commit ts) must migrate to wall-clock semantics before P>1 is possible; every index key and pagination cursor embeds it, so the migration touches physically-stored index keys or requires a compatibility epoch in the key codec. Cross-group creation-order becomes approximate under writer clock skew. If this slice-0 migration is botched, it's botched inside every index of every app.
3. **P is frozen at deploy time in v1, and the operational surface multiplies by P.** `hash(value) mod P` + one-document-one-group-forever means changing P requires an unbuilt slot-migration protocol (moving full revision chains between lines while both are live). Choosing P is an up-front capacity bet with no online correction; hot-key skew can't be rebalanced away. Meanwhile every node runs P tailer sub-loops, and lease holders run per-group driver instances — P× the leases, monitors, drivers, and failure-drill matrix that the shipped fleet debugged once. A fleet that misjudged P at 4 and needs 16 is looking at an export/import or waiting for v1.1's hardest slice.

Runner-up (disclosed): redefining `StateVersion.ts` as a node-local sequence forfeits the deferred ts-based version-gap resync across reconnects permanently — reconnecting clients keep paying full resync, which the global-line design might one day avoid.