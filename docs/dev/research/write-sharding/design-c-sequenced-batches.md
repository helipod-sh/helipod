# Write-Sharding Design C — "Sequenced Epochs": Deterministic Batch Ordering on the Shared Log

**Bias defended:** order-first, execute-second (Calvin/FoundationDB lineage), adapted to Stackbase's actual assets. The core move: stop deciding global order at commit time and stop discovering visibility after the fact. Instead, **pre-assign every commit's global position from a decentralized lattice — `ts = (epoch, shard, seq)` — and advance visibility batch-at-a-time at epoch boundaries.** The batch boundary *is* the closed timestamp. Gap-freedom is not a protocol you run; it is a property of the encoding.

The punchline versus every system in the evidence reports: Calvin needs sequencer nodes, FDB needs a singleton sequencer process, TiDB needs a TSO. Stackbase needs **zero sequencing round trips per commit and zero sequencer processes**, because (a) cross-shard transactions are rejected v1 (locked), so intra-batch order across shards is arbitrary and can be fixed by convention (shard ordinal), and (b) mutations are deterministic and IO-free by the engine's own contract, so per-shard serial execution in admission order is both cheap and replayable. The only serialized thing left in the whole write path is a per-node batched Postgres INSERT — which is a durability round trip we were paying anyway, now amortized over hundreds of commits.

---

## 0. The one structural decision everything follows from: structured hybrid timestamps

Keep the ONE global monotonic bigint line — every subsystem's load-bearing invariant (audit §1–§5) — but give the bigint internal structure:

```
ts (63 bits) = epoch (38 bits) | shardOrdinal (10 bits) | seq (15 bits)

epoch        = 10ms ticks since a fixed base (hybrid: max(wallTick, maxObservedEpoch, lastUsed))
shardOrdinal = 0..1023  (shard 0 = "default"; 1..N = logical shards)
seq          = serial commit counter within (epoch, shard); 32,768/tick = 3.2M commits/s/shard ceiling
```

Consequences, each resolving an audit MUST-HOLD directly:

1. **Global uniqueness with zero coordination.** No two writers can ever allocate the same ts: shard ordinal is embedded. No TSO, no PG sequence on the hot path, no HLC merge protocol. Allocation cost per commit: an in-memory increment.
2. **One ts = one transaction, globally** (MUST-HOLD 4) — strengthened from today ("unique per shard" was the fallback; we get globally unique for free). The replica tailer's atomic ts-group apply works unchanged, and **the `documents`/`indexes` tables need no `shard_id` column** — the shard is derivable from ts. The physical schema does not change.
3. **`_creationTime` becomes *more* meaningful, not less** (MUST-HOLD 9, the audit's "sleeper"). `tsToMs(ts) = epochBase + (ts >> 25) * 10 + (ts & 0x1FFFFFF) * (10 / 2^25)` — real wall-clock milliseconds with a monotone sub-tick fraction. Cross-shard comparable (epoch-major, skew-bounded), Convex-parity ("it's approximately real time"), unique enough (index keys already tiebreak on `_id`). This fixes the `kernel.ts:172` problem *before* forking anything, exactly as the audit demands.
4. **Every scalar-ts surface survives.** `StateVersion.ts`, action `maxCommitTs` folding (`executor.ts:283`), `/_fleet/run`'s single `commitTs`, `tailer.waitFor(ts)`, pagination cursors — all stay scalars on one comparable line. The vector-clock plague that kills per-shard-line designs never appears.

**One honest cost:** ts values exceed 2^53 within a few years of deployment lifetime, so the wire edges that currently do `Number(bigint)` (`write-fanout.ts:50`, `protocol.ts:17`, `forwarder.ts:104`) must carry ts as a decimal string / BigInt (protocol v2). Small, mechanical, and the audit already flagged those edges as due (MAY-RELAX 7). `_creationTime` stays a JS float (it's ms-scale).

Migration: the structured line starts strictly above all existing counter-style ts (epoch component is huge), so the oracle jump is a plain monotonic advance; old rows keep old ts. Old-vs-new `_creationTime` comparability breaks at the switchover boundary — documented, one-time, with an optional backfill tool.

---

## 1. Timestamp/ordering protocol: the epoch grid + node promises

### Who allocates

**Nobody central.** Each shard's writer allocates `(epoch, myShardOrdinal, seq++)` locally. Epoch is hybrid-monotone: `max(clockTick, lastEpochUsed + (flushed ? 1 : 0), maxEpochObservedInSharedTables)` — the last term is Lamport-through-Postgres and bounds inter-node skew to roughly one heartbeat without any clock-sync requirement.

### The batch ("sequenced batch" made concrete)

A node hosts many shard leases. Once per tick (10ms default; **adaptive: flush immediately when the queue was empty**, so an idle deployment pays ~0 added latency), the node flushes ONE Postgres transaction containing:

- all effect rows (documents + indexes, verbatim MVCC shape, original structured ts) for every commit its shards produced this tick,
- the intent rows for those commits (§below),
- an update to its single **promise row**: `node_promises(node_id) = { promisedEpoch: E, leaseGenerations: {...} }`,
- a fencing read: `SELECT generation FROM shard_leases WHERE shard_id = ANY(mine) FOR SHARE`, aborting the whole batch if any generation moved.

Semantics of the promise, written atomically with the data it covers: **"I will never again commit any row with epoch ≤ E."** Enforced locally by the hybrid epoch rule (next tick's epoch > E).

This is the brief's "one Postgres round-trip orders hundreds of commits" — except the round trip isn't even for *ordering* (order was pre-assigned); it's the durability write we already owed, batched.

### The exact safe-visibility rule (the closed timestamp)

```
closedEpoch  = min over nodes holding ≥1 live lease of node_promises.promisedEpoch
frontierTs   = ((closedEpoch + 1) << 25) − 1
```

**Rule for every reader (tailer, snapshot, cursor, subscription): all ts ≤ frontierTs form a complete, immutable, gapless prefix. Read at ≤ frontierTs, never above.**

Why it's gap-free *by construction*, not by convention:
- Within one node: promise E and epoch-E data commit in the same PG transaction; a node's flushes are sequential on one connection, so any snapshot that sees promise E sees every earlier flush from that node (PG commit-order visibility).
- Across nodes: the min over live promises means every node has durably forsworn epochs ≤ closedEpoch. Nothing can ever land below the frontier — fencing makes a deposed writer's late flush *abort atomically* rather than land low (this replaces the fragile `observeTimestamp(maxTimestamp())` promotion fence and satisfies MUST-HOLD 5 outright: in-flight commits from a dead writer below the successor's line are physically impossible, not merely improbable).

This is Kafka's LSO + CRDB's closed timestamp + Convex's `max_repeatable_ts`, quantized to the epoch grid and paid for at **node** granularity, not shard or commit granularity.

### Costs

- **Per commit:** zero dedicated ordering work. 1/batchSize of a PG transaction.
- **Per tick per node:** one batched INSERT txn (only when there's data) — O(nodes), not O(shards) or O(commits).
- **Idle:** one promise-only heartbeat per node per 50ms.
- **Frontier read:** one small SELECT per tail cycle, plus the existing NOTIFY wake-up.
- **Worst-case staleness:** normal path = 1 tick + batch commit RTT + residual skew (≈ 15–40ms). Pathological = **lease TTL during a node crash** (the dead node pins the min until its lease expires and evicts it — frontier stalls a few seconds; correctness never at risk, and writes on healthy shards keep committing, just invisibly). A live-but-wedged node is the ugly case; it needs self-eviction + alerting (see Weaknesses).

---

## 2. OCC and serializability: order-first per shard, snapshot-consistent across

### Per shard: strict serializability, zero aborts

Sharded shards abandon commit-time OCC in favor of **admission-ordered serial execution**: the shard's writer executes its intent queue one at a time; intent order = seq order = commit order = ts order. The `recentCommits` ring and conflict check (`single-writer-transactor.ts:199–203`) are simply *unnecessary* on this path — there is no concurrency to validate against. Contention-induced retries disappear entirely (Calvin's headline property).

Why serial is safe to bet on: **Stackbase mutations cannot do IO.** No fetch, no timers, no disk — that's the engine's own determinism contract; side effects live in actions. A mutation is pure CPU over local reads (writer-local SQLite replica + this tick's in-memory overlay for read-your-own-shard-writes). This is exactly VoltDB's partition model, validated at 100k+ TPS/partition. The pathological case (a mutation `collect()`ing 100k docs) blocks only its own shard — named in Weaknesses. A future escape hatch exists and stays deterministic: pipelined speculative execution of intent k+1 against k's output (order is already fixed, so speculation can never abort for ordering reasons).

Shard 0 (default/unsharded) may keep today's transactor verbatim — pipelined OCC, ring and all — since it is exactly today's single writer.

### Cross-shard writes

Do not exist. Locked v1 decision, structurally enforced: `ctx.db.insert/patch/replace/delete` on a table whose resolved shard ≠ the executing shard throws `CrossShardWriteError` with a fix-it message ("declare `shard:` / co-locate via shardKey / use ctx.scheduler to enqueue a mutation on the other shard").

### Cross-shard READS inside mutations — the write-skew policy, stated honestly

A mutation on shard S may **read** foreign shards (including unsharded tables — the common "look up the user while writing a message" case must work). Mechanism: at admission, the intent records `readFrontierTs` = the current closed frontier; all foreign reads execute at exactly that MVCC snapshot. Because the frontier is a closed prefix of one global line, the foreign view is a **consistent snapshot**, and because the snapshot ts is journaled in the intent, execution stays **deterministically replayable**.

What you do NOT get: serializability across the shard boundary. The foreign shard's writer never sees your read set — **write skew across shards is possible.** Concretely: shards A and B each read "combined balance across both ≥ 100" at frontier F and each debit locally; both commit; the cross-shard invariant breaks. Policy, stated in docs with this exact example: *cross-shard reads are stale-but-consistent (bounded by frontier staleness, ~15–40ms); any invariant you need transactionally enforced must live on one shard — that is what the shard key is for.* Multi-shard business processes use `@stackbase/workflow` sagas (already shipped, already the right tool). This is the same honesty Vitess/Citus/Lunora ship with, except we upgrade the foreign read from "N unrelated snapshots" (Lunora's fan-out) to "one consistent global snapshot."

### Component co-commit (audit MUST-HOLD 10)

`ctx.scheduler.*` and the workflow journal write in the caller's transaction, so those rows commit at the caller's shard's ts and **belong to the caller's shard**. Scheduler jobs partition by originating shard; one scheduler driver per shard, hosted on that shard's lease holder (the driver seam already runs on the writer). Workflow journals co-locate with the shard that started the workflow; each `step.runMutation` is already dispatched as a fresh top-level run through the scheduler, so a step can route to a *different* shard and its completion writes back to the journal's shard as a separate transaction — **the shipped step-as-independent-run architecture is accidentally shard-ready.** No carve-out needed.

---

## 3. Mutation routing DX

### The public API

```ts
// convex/schema.ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  channels: defineTable({
    name: v.string(),
  }).shardKey("_id"),                          // root entity: shards by its own id

  messages: defineTable({
    channelId: v.id("channels"),
    body: v.string(),
  }).index("by_channel", ["channelId"])
    .shardKey("channelId"),                    // co-located: hash(channelId value) — same shard as its channel

  users: defineTable({ name: v.string() }),    // no shardKey → default shard, exactly today's semantics
});
```

```ts
// convex/messages.ts
export const send = mutation({
  args: { channelId: v.id("channels"), body: v.string(), authorId: v.id("users") },
  shard: "channelId",                          // ← the whole routing API: name the arg carrying the shard key
  handler: async (ctx, { channelId, body, authorId }) => {
    const channel = await ctx.db.get(channelId);          // local read (co-located)
    if (!channel) throw new Error("no such channel");
    const author = await ctx.db.get(authorId);            // FOREIGN read (default shard) — consistent snapshot at readFrontierTs
    await ctx.db.insert("messages", { channelId, body }); // local write ✓
    // await ctx.db.patch(authorId, {...})                // ✗ CrossShardWriteError
    return { name: author?.name };
  },
});
```

```ts
// client — completely unchanged; the client never learns shards exist
await client.mutation(api.messages.send, { channelId, body, authorId });
```

Routing happens **server-side, before execution**, at the existing chokepoint the audit identified: `WriteRouter.forward(kind, path, args, identity)` (`runtime.ts:152–154`) resolves `shard = hash(args[shardField]) % 1024` via the dormant `ShardRouter`/`ShardKeyResolver` seams and forwards over the existing `/_fleet/run` to that shard's lease holder. Because the server resolves the shard from validated args, **Lunora's entire `authorizeShard` attack surface never exists** — the shard key is not client-addressable.

Rules:
- Mutation with no `shard:` declaration → runs on the default shard; may read anything (at frontier), may write only unsharded tables. Writing a sharded table from it throws with a fix-it.
- `shard:` field must be present in `args` and validated — checked at push/codegen time when statically possible, at admission otherwise.
- **Shard-key immutability:** `patch`/`replace` changing a document's shard-key field throws (MUST-HOLD 3 — a document's revision chain has one owning shard forever). Moving an entity across shards = app-level copy + tombstone (or a future migration primitive).
- Queries never declare anything: all reads execute at the closed frontier, which is globally consistent (§4).

### Tier-0: the same code, byte-for-byte behavior

A single binary / single `serve` process holds **all 1024 shard leases trivially** (it is the only node). Shard resolution still runs (a hash — nanoseconds), forwarding is loopback, the frontier is the node's own promise (`closedEpoch = my last flush`, i.e., effectively "everything I committed"), tick can degrade to flush-per-commit. `.shardKey`/`shard:` become semantically inert annotations; an app with no `.shardKey` at all never touches any of this. The one observable delta at every tier is the slice-0 timestamp restructure (ts magnitude / `_creationTime` = real ms) — a deliberate, documented, tier-uniform change, not a tier fork.

---

## 4. Cross-shard reactive queries/subscriptions — the thing no ancestor kept alive

This is where the design cashes in hardest, and it's almost free:

- The shared Postgres log carries **all shards' rows on one ts line**; every sync node's replica tailer applies everything (unchanged full-copy replica model). So every sync node already has every shard's data and every shard's deltas.
- Range-precise invalidation (`subscription-manager.ts:88–102`) is pure byte-range intersection keyed by `(tableId, index)` — **already shard-agnostic** (audit seam 7). A write on any shard whose range intersects a subscription's read set triggers a re-run. No change.
- Re-runs execute at the **closed frontier** — which, because the frontier is a stable prefix of the single global line, is a **true consistent multi-shard snapshot**. A subscription spanning 50 channels' shards re-runs against one coherent world-state, never a torn stitch.
- Ordering: the tailer applies pulled rows in ts order (epoch-major, shard-minor) — deterministic cross-shard interleave. Deltas from different shards re-running a subscription in arbitrary arrival order is already tolerated (audit MAY-RELAX 6): worst case is an extra re-run, never wrongness, because every re-run reads a closed frontier.
- `StateVersion.ts` = the node's served frontier: a monotone scalar for which "everything ≤ ts is reflected" is **true again by construction** — which un-blocks the deferred ts-based version-gap resync optimization rather than killing it.

Lunora's answer to this was "move the table to D1 and accept poll-and-diff." Convex never sharded. **A live, range-invalidated, consistent-snapshot subscription across write shards is the genuinely novel deliverable**, and it falls out of (frontier = closed prefix of one line) + (shipped intersection machinery).

Pagination: cursors are `(indexKey, _id)` at MVCC snapshots; snapshots are now frontier ts values; stable prefix ⇒ cursors work unchanged, including across shard-spanning tables (the index rows all live in the one shared `indexes` table with globally-unique keys).

## 5. Replica tailer + RYOW

Tailer changes (the audit's hardest site, `replica-tailer.ts:207–262`):
- Pull rule: `(wm, frontierTs]` instead of `(wm, maxTimestamp()]` — the frontier read replaces `maxTimestamp()`. The skipped-ts-99 bug is dead: ts 99 cannot be invisible below a closed frontier.
- ts-group atomic apply: unchanged (one ts = one txn, now globally).
- Wake-ups: existing NOTIFY + 1s poll, now also NOTIFYing on promise advances.

RYOW: `/_fleet/run` returns the structured `commitTs` (one scalar, as a string). The serving sync node does exactly today's `tailer.waitFor(commitTs)` against its applied frontier. Wait ≈ 1–2 ticks + batch RTT — same order as today's watermark wait. Action RYOW (`executor.ts:283`): the scalar `maxCommitTs` fold still works verbatim, because the line is still one line. Vector-frontier designs break this surface; we don't.

One consistency simplification: **all served reads — even on the writer node, even same-shard — happen at the closed frontier.** The writer's ahead-of-frontier state is used only for mutation execution. This keeps `StateVersion` single-line and node-uniform; the cost is that a same-node read-after-write waits the same 1–2 ticks as everyone else (mutation return values still give immediate data to the caller).

## 6. Failover per shard — extending the shipped lease machinery

- `fleet_lease` (one row) → `shard_leases(shard_id PK, generation, node_url, expires_at)` + per-shard advisory-lock keys. Nodes acquire lease *sets* (typically contiguous ordinal ranges); role becomes per-shard (a node is writer for its shards, sync for the rest — audit MAY-RELAX 5).
- Promotion per shard = the shipped 7-step order, parameterized, with two upgrades:
  1. **Fencing is transactional, not temporal**: every batch flush re-validates lease generations `FOR SHARE` inside the flush txn. A deposed writer's in-flight batch aborts; it cannot land below the successor. (Replaces `observeTimestamp(maxTimestamp())`'s blind spot for in-flight commits.)
  2. **Epoch seeding**: successor's first epoch = `max(ownClockTick, maxEpochInPromises, maxEpochOfShardRows) + 1` — one query, and the fence makes even a wrong seed non-corrupting (a collision would abort at flush).
- Timeline identity (Lunora's epoch-UUID lesson): unnecessary here — the global line never forks, because stale writes abort rather than land. Lease generation plays the fencing role; cursors never resume onto forked history because there is no forked history.
- Frontier during failover: the dead node's promise pins the min until its lease TTL expires; then it drops out and the frontier snaps forward. Staleness spike = TTL; zero correctness impact.
- The intent journal (§below) upgrades failover UX: acked mutations are exactly-once by construction, and *retried* in-flight mutations dedup against `(shard, mutationId)` intent rows (result value stored in the row), so a client retry across failover returns the original result instead of double-applying. No ancestor's fleet had this; Lunora needed client watermarks per DO to approximate it.

### The intent journal (the deterministic asset, scoped honestly)

Each flush also writes `intents(shard_id, mutation_id PK, path, args, identity, readFrontierTs, commitTs, resultValue)`. What it is **for**, in v1: exactly-once retry semantics across failover; a complete, ordered, replayable audit of every write (the substrate for replay-debugging, currently deferred in workflow — this makes it engine-wide); divergence checking (re-execute a shard's intents against a snapshot, diff the effects — a CI-able determinism proof no competitor can run). What it is **not**, in v1: the replication substrate — replicas keep tailing effects verbatim, because intent replay is only valid within one code version, and deploys hot-swap functions. Replay across versions is invalid and rejected. (This honest scoping is what keeps determinism a superpower rather than a correctness trap.)

## 7. Deploy-anywhere check

- **Postgres-only, default:** three small tables (`shard_leases`, `node_promises`, `intents`) + the advisory locks the fleet already uses. No Redis, no etcd, no clock hardware, no sequencer service, no coordinator process — the store remains its own coordinator (tier2-topology-research.md's locked constraint, extended not violated). Clock quality only affects *staleness* (via skew, bounded by table-gossip catch-up), never correctness.
- **Self-host:** `stackbase serve --fleet` unchanged in shape; shard count is a config knob; a 1-node "fleet" is Tier 0.
- **Object-storage future:** the epoch grid IS the object layout. Each node's per-epoch batch = one immutable, pre-ordered blob (`epoch/E/node-N.bin`); the closed frontier = a manifest append (CAS on a manifest object replaces the promise-row min). Tailers list-and-apply blobs per closed epoch. The intents journal ships the same way and enables replay-based thin replicas. Nothing in the visibility rule assumes SQL — it assumes "atomic batch publish + min-over-writers promise," which S3-compatible CAS provides. This is the cleanest object-storage story of any candidate design precisely because visibility is batch-quantized rather than per-commit.

## 8. Incremental build path from the shipped fleet

- **Slice 0 — structured hybrid timestamps (tier-uniform, no sharding).** Oracle allocates `(epochFromClock, 0, seq)`; `_creationTime` becomes real ms; wire ts widens to string. All existing tests pass with ts-shape expectations updated. Self-contained, independently shippable, and fixes `_creationTime` semantics (a Convex-parity item on its own).
- **Slice 1 — epoch group-commit + promises + frontier-bounded tailer, still ONE writer.** The single writer batches its PG flushes per tick and publishes promises; the tailer switches from `maxTimestamp()` to the frontier. Zero sharding risk; proves the entire visibility protocol; and — free lunch — the single writer can now pipeline commits Convex-style (execute k+1 while k's batch flushes), an immediate throughput win on the *shipped* fleet.
- **Slice 2 — shard leases + routing.** `shard_leases`, per-shard promotion, `WriteRouter` shard resolution, the `shard:` mutation API + `.shardKey` activation, cross-shard write rejection, foreign reads at `readFrontierTs`. Ship gate: 2 writer nodes, a sharded chat app, a cross-shard live subscription, and a kill-the-writer failover — all through real `stackbase serve` (per the E2E-through-shipped-entrypoint rule).
- **Slice 3 — intent journal + exactly-once retry; per-shard scheduler drivers; workflow co-location.**
- **Slice 4 — operations.** Lease-set rebalancing (note: **moving a shard = moving a lease — zero data copy**, since the substrate is shared; the perpetual resharding nightmare of physical-shard systems simply doesn't exist here), hot-shard dashboards, self-eviction for wedged nodes.

## 9. Performance model

- **Throughput:** per shard, serial execution of IO-free mutations ≈ 10–50k/s (20–100µs handlers). Fleet aggregate scales linearly in shards until the real ceiling: **the shared Postgres's batched ingest rate** (~50–150k row-writes/s with multi-row inserts on decent hardware) and each sync node's tailer apply rate (every replica still applies everything). Versus today's ~1–3k commits/s (one PG txn + fsync per commit), group commit alone is ~5–10×, and sharding takes the *compute/serialization* ceiling off entirely: expect **10–30× end-to-end** before the substrate saturates. Honest curve: linear → knee at PG ingest → flat. (The object-storage substrate is the designed answer to the knee, not more shards.)
- **Latency added per commit:** ≤ 1 tick queueing (adaptive flush ⇒ ~0 when idle) + the PG batch commit (which replaces, not adds to, today's per-commit PG write). p50 under load likely *improves* (group commit).
- **Visibility/RYOW latency:** 1–3 ticks ≈ 10–40ms (today: watermark poll, comparable).
- **Frontier maintenance:** O(nodes) writes per tick, O(1) reads per tail cycle. Independent of commit rate and shard count — the epoch quantization is exactly what keeps this true at 1024 shards.
- **Remaining bottleneck, named:** the single Postgres log — bandwidth, fsync, storage, and N-full-copies tailer fan-out. We sharded ordering, execution, validation, and failure domains; we did not shard the durability substrate.

## 10. Weaknesses — the three worst, named by the author

1. **Fleet-wide visibility is hostage to the slowest promise (min-frontier head-of-line blocking).** One wedged-but-lease-holding node — GC pause, PG connection stall, half-dead VM — freezes the closed frontier for *everyone*: all reads go stale, all RYOW waits lengthen, all subscriptions stop advancing, across shards that node doesn't even own, for up to the lease TTL. Writes keep committing invisibly, which makes the failure mode confusing to operate ("the app froze but nothing is erroring"). Per-shard-vector designs degrade only the sick shard. Mitigations (self-eviction watchdog, short TTLs, promise-lag alerting) shrink the window but cannot remove the systemic coupling — it is the price of keeping one scalar version line, and I'm claiming the price is worth it, not that it's zero.
2. **Per-shard serial execution has no answer to a single hot or heavy shard.** Dropping intra-shard OCC means one slow mutation (a large `collect()`, a pathological loop) head-of-line-blocks its entire shard, where today's pipelined OCC would overlap it; and a workload whose writes concentrate on one shard key (one mega-channel, one tenant = 80% of traffic) gets exactly one shard's serial throughput with no relief valve — hash-splitting a *single* key's traffic is impossible by design (co-location is the point). Deterministic speculative pipelining is a credible future fix for the first half; the second half is a documented modeling constraint ("pick a key with cardinality"), which is honest but is also what every sharded system says right before a customer hits it.
3. **The migration is observable and the wire changes are real.** Slice 0 changes the magnitude and meaning of every new ts and `_creationTime` (old counter-scale vs. new ms-scale values don't compare), and forces ts-as-string at protocol edges — touching the client, the sync protocol, the fanout payload, and every stored expectation in 131+ tests, *before any sharding value is delivered*. If slice 0 ships with a subtle bug (epoch monotonicity across restarts, the 2^53 edge, an unconverted `Number(bigint)`), it corrupts the one invariant everything trusts — and unlike the later slices, it cannot hide behind a feature flag because timestamps are load-bearing everywhere. This design front-loads its riskiest change; that is a deliberate trade (every later slice becomes small) but it is the single most likely place this project eats an outage.

*Honorable mentions:* cross-shard write skew will eventually surprise an app author no matter how loudly documented; the intents table adds ~30–60% row volume to the log (tunable retention); and 1024 fixed logical shards is a forever number — chosen generously for that reason, but forever.

---

**Why this is the uniquely-Stackbase answer:** every competitor either serializes commits (Convex), buys ordering with hardware (Spanner), runs sequencer/oracle services (FDB/TiDB/Calvin), or abandons cross-shard consistency entirely (Lunora/Vitess/Citus). Stackbase's locked constraints — deterministic IO-free mutations, single-shard transactions, one shared Postgres, lease-elected writers — are exactly the preconditions under which global order can be *encoded* instead of *coordinated*: a timestamp lattice plus an atomic-batch promise makes the visibility frontier gap-free by construction, keeps every scalar-ts invariant in the engine intact, keeps cross-shard subscriptions live on true consistent snapshots (which nobody in the lineage achieved), and journals every write as a replayable intent — the foundation for replay-debugging and object-storage replicas no other BaaS can build without a rewrite.