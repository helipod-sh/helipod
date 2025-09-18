# Sharding Constraints Audit — binding invariants from the code as it stands

Scope: every load-bearing assumption of the ONE global monotonic ts line, verified by reading the sources on `scheduler-component` (repo `/Volumes/Projects/concave-dev`). For each site: what breaks under **(a)** per-shard independent ts lines, and **(b)** globally-allocated but out-of-order-committed ts.

---

## 1. Transactor — `packages/transactor/src/single-writer-transactor.ts`

| Site | Assumption | (a) per-shard lines | (b) out-of-order global ts |
|---|---|---|---|
| L136–139 `mutex` + `recentCommits` + `activeSnapshots` | OCC state is **process-local, per-transactor-instance** memory. Correct only if this instance is the *sole* writer of everything its transactions read/write. | Fine **iff** one transactor per shard and every transaction's read+write set resolves to that shard. A read that leaks across shards is invisible to this ring → silent lost update. | Broken outright: a peer writer's commit never enters this ring at all. |
| L166 `snapshotTs = oracle.getLastCommittedTimestamp()` | Snapshot = the single committed frontier; everything ≤ it is applied (comment L163–165 makes this explicit). | Needs one frontier **per shard**; a cross-shard read needs a *vector* of frontiers, each individually stable. | Fatal: `lastCommitted = 101` while ts 99 is in flight means the "snapshot" at 101 is not a stable prefix — 99 lands later *inside* the snapshot. |
| L199–203 conflict iff `c.ts > snapshotTs && reads.intersects(c.writes)` | Strict `>` presumes total order on one line: any commit not in the ring when we snapshotted has `ts <= snapshotTs` **and is already visible**. | Safe per shard (each shard has its own ring + line). | Broken: peer's commit at ts 99 landing after we snapshot at 100 has `c.ts < snapshotTs` → conflict check passes → lost update. This check **cannot** be made safe across parallel writers without either shard-disjointness or commit-frontier coordination. |
| L206 `commitTs = oracle.allocateTimestamp()` (under mutex, L182) | Allocate→apply→publish is **atomic under one lock** — allocation order ≡ commit order ≡ visibility order. This atomicity is exactly what parallel writers destroy. | Per shard: keep the mutex per shard, invariant preserved. | The entire reason problem (1) exists. |
| L214 `prev = await this.docStore.get(w.id)` (latest, no ts) | prev_ts revision chaining assumes this writer sees **all** prior revisions of the doc → a document has exactly one owning writer, ever. | Must hold per shard: a document's revision chain lives on one shard. Resharding/moving a doc across shards must migrate or terminate its chain. | Broken if two writers can touch the same doc. |
| L225–228 push to ring **then** `publishCommitted(commitTs)` under mutex | Frontier only advances after apply — readers of `getLastCommittedTimestamp` never see a ts whose writes aren't applied. Per-shard designs must reproduce this publish discipline per shard. | OK per shard. | This is precisely the discipline a shared global sequence loses — allocation is global, publish is per-writer. |
| L250–272 retain/release + `prune()` by min active snapshot | Snapshot lifetimes and the ring share one line. | Per shard, unchanged. | Pruning by min-active-snapshot would wrongly drop a not-yet-visible peer commit. |
| L177–179 pure read returns `commitTs: snapshotTs` (scalar) | The RYOW token for reads is a single scalar. | Must become shard-qualified (or 0 for reads). | Scalar loses meaning. |

## 2. DocStore contract + both stores

**`packages/docstore/src/types.ts`**
- L7–8 (doc comment), L102 `get(id, readTimestamp)`, L105–112 `index_scan(..., readTimestamp, ...)`: snapshot = "newest revision with `ts <= readTimestamp`". A snapshot is only *consistent* if all ts ≤ readTimestamp are present. **(b)** breaks this: a served snapshot mutates retroactively when ts 99 lands after reads at 100 were served — which also breaks **deterministic re-execution**, the root of the reactivity model. **(a)** fine per shard; cross-shard reads need each shard's readTimestamp ≤ that shard's closed frontier.
- L115 `load_documents(TimestampRange)`: the change feed is keyed by **ts alone** — no shard dimension. **(a)**: colliding ts across shards makes a shared feed unpartitionable; **(b)**: a `(wm, newMax]` pull permanently skips late-landing ts (see §5).
- L126–127 `maxTimestamp()`: "restart recovery high-water mark" — max implies complete prefix. **(b)**: max=101 with 99 in flight → oracle seed fine, but every *watermark* consumer of it breaks.
- L94–99 `write(..., shardId?)`: shardId accepted but **dropped** by both stores — `packages/docstore-postgres/src/postgres-docstore.ts:124` (`_shardId`), `packages/docstore-sqlite/src/sqlite-docstore.ts:96` (`_shardId`). The physical log has **no shard column** (see PKs below). Any per-shard log/watermark needs an (additive) `shard_id` column or per-shard physical logs.
- L137–147 `TimestampOracle` — doc comment already says "**one per shard**"; `observeTimestamp` (impl `timestamp-oracle.ts:34–37`) is the follower clock-advance primitive. Seam exists.

**PKs — `packages/docstore-postgres/src/schema.ts`** (SQLite identical, `sqlite-docstore.ts:34–51`):
- L11 `PRIMARY KEY (table_id, internal_id, ts)`: ts is **not** assumed globally unique — only unique per document. Two shards may allocate the same ts for different docs without collision. Same-doc collision is prevented only by single-owner-per-doc (§1 L214).
- L21 `PRIMARY KEY (index_id, key, ts)`: safe across shards because index keys are **globally unique** — they embed `_creationTime` and `_id` (`packages/query-engine/src/index-manager.ts:3, 23–32`).
- L13 `documents_by_ts (ts)`: the feed index — ts-alone again.
- `postgres-docstore.ts:127–132`: write() dedup is justified by "**the transactor allocates exactly one commit ts per transaction**" — this one-ts-per-transaction invariant is load-bearing in the tailer (§5) and must survive per shard as one-`(shardId, ts)`-per-transaction.
- `postgres-docstore.ts:113–117` `acquireWriterLock`: **one** advisory lock per database — the single-writer invariant is currently deployment-global, not per-shard. Generalizes (lock key per shard) but is a today-binding assumption.

## 3. The sleeper: `_creationTime` IS the logical timestamp

- `packages/executor/src/kernel.ts:172` — `_creationTime: Number(ctx.snapshotTs)` on insert (L196 preserves it on replace). The logical ts line leaks into **user-visible document data**.
- `packages/query-engine/src/index-manager.ts:23–32` — every index key is `[...fields, _creationTime, _id]`. So the ts line is physically embedded in **every index key of every table**, and in every pagination cursor (cursors are raw key bytes, `query-runtime.ts:154–156, 214–215`).
- **(a)** per-shard independent lines: `_creationTime` becomes cross-shard-incomparable (shard A at ts 50,000, shard B at ts 12); `by_creation_time` ordering over a table whose rows span shards is meaningless; users who treat it as time (Convex parity: ms-epoch) get garbage. **(b)**: creation order ≠ commit order — mild, since `_id` tiebreaks uniqueness, but "later insert has smaller `_creationTime`" becomes observable.
- Any design must either (i) decouple `_creationTime` from the shard line (wall-clock/hybrid — a Convex-parity fix anyway), or (ii) keep a single global allocation so lines are comparable. This is a **schema-visible** decision, not an internal one.

## 4. Executor, sync protocol, client

- `packages/executor/src/executor.ts:187–195` — queries AND mutations run through `runInTransaction`; a query's readTimestamp *is* `txn.snapshotTs` — one scalar. A cross-shard query needs a consistent multi-shard snapshot (vector of closed frontiers), or it's torn.
- `executor.ts:283–292` — action RYOW folds inner commits into **one scalar** `maxCommitTs` (`res.commitTs > maxCommitTs`). Per-shard: must become a per-shard max (frontier map).
- `packages/sync/src/protocol.ts:13–20` — `StateVersion { querySet, ts: number }`: **one scalar ts brackets a whole session** across all its subscriptions, regardless of which shard invalidated. L26–35 comparison/contiguity.
- `packages/sync/src/handler.ts:47` (`runMutation → commitTs: number`), L209–213, L272–275 (`endVersion.ts = invalidation.commitTs`): the session version adopts each invalidation's commitTs. With multi-shard feeds the scalar can **regress**. Today's client survives (equality-only check: `client-reducer.ts:38–41`, `packages/client/src/client.ts:161–166` + resync L220–225), but the ts loses its "everything ≤ ts reflected" meaning — which the *deferred* version-gap resync optimization depends on. Also `handler.ts:241–245` (`notifyTail`) serializes notifies per process — cross-shard arrival order is arbitrary, acceptable only if `ts` is redefined as a node-local frontier/sequence.
- `packages/runtime-embedded/src/write-fanout.ts:11–16, 50` — `EmbeddedWriteFanoutPayload` carries `commitTs: Number(bigint)` and **DROPS `shardId`**, even though `OplogDelta` (transactor/types.ts:17–22) carries it. First concrete wire gap: fan-out consumers can't attribute a delta to a shard today.
- `packages/runtime-embedded/src/runtime.ts:165` — oracle seeded from `store.maxTimestamp()` (one scalar, one oracle per runtime); L568–569 `observeTimestamp` delegates to that one oracle. Per shard: N oracles per node.

## 5. Fleet — where problem (1) is most concrete

**`ee/packages/fleet/src/replica-tailer.ts`**
- L123 (`wm = replica.maxTimestamp()`), L207–211 (`newMax = primary.maxTimestamp()`; pull `(wm, newMax]`), L262 (`wm = appliedMax`): the watermark protocol **is** the "all ts ≤ X are present" assumption. **(b) is fatal here**: if ts 99 lands after 101 is visible and `wm` advanced to 101, the next pull is `(101, …]` — **99 is skipped forever** on every replica. This is the single hardest site.
- L272–277 + L292–294 (`pullDocs` ts-group batching): "a ts group = exactly one transaction" — atomic-apply depends on it. Per-shard lines in a *shared* table make a ts value span shards; invariant must become `(shard_id, ts)`-group.
- L214: index rows pulled by `ts > $1 AND ts <= $2` from the shared `indexes` table — no shard filter possible today (no column).
- L175–189 `waitFor(ts)`: RYOW compares a scalar commitTs against **one** watermark.

**`ee/packages/fleet/src/forwarder.ts`**
- L104, L138–168: `/_fleet/run` returns one stringified `commitTs`; RYOW waits `tailer.waitFor(commitTs, 5000)` (L39, L163). Per-shard: response must carry `(shardId, commitTs)` and wait on **that shard's** watermark. Also `runtime.ts:240–244` returns `commitTs: 0` for the WS path on a forwarded write (safe — the wait happened inside `forward()`), a pattern that must be preserved per shard.

**`ee/packages/fleet/src/lease.ts` + `node.ts`**
- `lease.ts:39–46`: `fleet_lease` has `id INTEGER PRIMARY KEY CHECK (id = 1)` — **one** row, one epoch, one writer_url. Per-shard: key by shard_id + per-shard advisory-lock keys.
- `node.ts:426–434` `promoteFleetNode`: step 1 `observeTimestamp(await pgStore.maxTimestamp())` — the new writer's first allocation must exceed *all* history. Per shard: seed per shard-line; **(b)**: `maxTimestamp()` may exclude a still-in-flight lower ts from the dying writer — promotion must fence the old writer's in-flight commits (lease epoch fencing at the store) or those commits land *below* the new writer's line: silent corruption.
- `node.ts:532–551`: sync node's oracle/frontier advanced by `observeTimestamp(inv.newMaxTs)`, StateVersion fed `Number(newMaxTs)` — one scalar per node; whole-node binary role (`role(): "sync" | "writer"`, L102–109, L480, L556–572) — per-shard means a node is writer for some shards, sync for others.

## 6. Scheduler / workflow components

- `components/scheduler/src/facade.ts:214–221, 236–241`: `ctx.scheduler.runAfter/runAt` **writes the `scheduler/jobs` table inside the calling mutation's own transaction** (context providers share `kctx.txn` — `executor.ts:210–218`). Same for the workflow journal. Under "one transaction = one shard" (locked), an app mutation on shard S enqueuing a job is a **cross-table single commit spanning app tables + component tables**. Binding consequence: component tables must be co-located with the *caller's* shard (i.e. sharded by caller-shard) or the one-shard rule needs an explicit carve-out. This is the biggest *unstated* routing constraint.
- `components/scheduler/src/driver.ts` (single `running` flag, commit-wake): assumes **exactly one driver instance per deployment**, coupled to the single writer (`deferDrivers`, `startDrivers` at promotion step 7, `node.ts:433`). Per-shard writers → one driver per shard's jobs partition, running on that shard's lease holder.
- `components/workflow/src/modules.ts:192–208, 322–325`: `generationNumber` OCC guard is **data-level** — survives any per-shard serializable scheme, provided a workflow's `workflows`/`steps`/`events` rows + its scheduler jobs live in the **same shard** (each transition reads-then-writes them in one txn). No commit-ts ordering assumption found; ordering rests on wall-clock `runAt` + journal `stepNumber`.

## 7. Codegen / client

- No ts assumptions in codegen. The client never sees commitTs except as `StateVersion.ts` (§4). **The mutation-routing seam does not exist at the API surface**: nothing in `mutation({...})`, codegen, or the client threads a shard key. But the runtime chokepoint does: `WriteRouter.forward(kind, path, args, identity)` (`runtime.ts:152–154`, consulted by *every* mutation/action entry point **before local execution**) already has exactly the `(path, args) → destination` shape a `shardBy`-style router needs.

---

## Existing seams that help (verified, with consumers today)

1. **`shardId` threading, end to end typed**: `transactor/types.ts:17–31` (`OplogDelta.shardId`, `CommitResult.shardId`), `:66` (`RunInTransactionOptions.shardId`); `single-writer-transactor.ts:149,159`; `DocStore.write(shardId?)` (`docstore/types.ts:98`). Gap: both stores drop it; `EmbeddedWriteFanoutPayload` drops it.
2. **`ShardRouter` / `ShardKeyResolver` / `.shardKey(field)`**: `id-codec/shard.ts:19–65`, `values/schema.ts:97–115`, registry metadata `id-codec/table-registry.ts:16–33,96,126`, propagated for component tables at `component/src/compose.ts:41`, surfaced in `admin/src/admin-api.ts:61–76`. Zero runtime consumers — clean to activate.
3. **`TimestampOracle` is already spec'd one-per-shard** (`docstore/types.ts:137`) with `observeTimestamp` as the follower-advance primitive.
4. **`WriteRouter`** — the pre-execution routing chokepoint already exists and is fleet-proven (`forwarder.ts` implements it; `runtime.ts:152–154` consults it for every write). Mutation routing DX = resolve shard from `(path, args)` here.
5. **Lease pattern generalizes**: advisory lock + `fleet_lease` discovery row + `LeaseMonitor` + the 7-step promotion order (`node.ts:426–434`) are all parameterizable by shard.
6. **`ReplicaTailer`** generalizes to per-shard tails *if* the log gains a shard dimension (or a safe-frontier bound replaces `maxTimestamp()` as `newMax`).
7. **Range-precise invalidation is shard-agnostic**: `subscription-manager.ts:88–102` is pure byte-range intersection over keyspaces keyed by `(tableId, index)` — no ts, no shard. Cross-shard subscriptions work as long as every shard's deltas reach the serving node; `handler.notifyWrites` is already payload-driven with the external-fanout mode (`handler.ts:61–69`, `autoNotifyOnMutation:false`).
8. **One-ts-per-transaction + globally-unique index keys** (`_id` tiebreaker) mean shared physical tables never collide across shards for *different* documents.
9. **`SwitchableDocStore`** (`switchable-store.ts:37+`) — atomic store repointing for per-shard promotion.

---

## MUST HOLD (any design)

1. **Snapshot immutability**: once any reader has been served at `(shard, ts)`, no commit may later become visible at ≤ that ts on that shard. Everything — OCC (`single-writer-transactor.ts:199–203`), deterministic re-execution, subscription correctness, replica watermarks (`replica-tailer.ts:207–262`) — rests on this. Equivalent formulation: each shard's **visibility frontier is a gapless, monotonically-closed prefix**, and all reads happen at ≤ a closed frontier.
2. **One transaction = one shard, for reads AND writes** (locked decision, and structurally required by the per-shard in-memory OCC ring). The shard must be resolvable **before execution** (routing happens at `WriteRouter`, pre-execution).
3. **One document = one owning shard, forever (or migrated with its full revision chain)** — prev_ts chaining (`single-writer-transactor.ts:214`) and the `(table_id, internal_id, ts)` PK require it.
4. **One commit ts per transaction, unique within its shard** — the tailer's atomic-apply grouping depends on it (`replica-tailer.ts:272–294`, `postgres-docstore.ts:127–132`).
5. **Writer fencing at promotion**: a deposed writer's in-flight commits must be prevented from landing below the successor's line (today: `observeTimestamp(maxTimestamp())` + advisory-lock release; per shard this needs an epoch/fence at the store, because `maxTimestamp()` cannot see in-flight ts).
6. **RYOW per shard**: a client that committed at `(shard, ts)` never subsequently reads that shard below ts (`forwarder.ts:138–168` generalized).
7. **Cross-shard reads/subscriptions keep working**: a query may span shards but must read each shard at a closed frontier, and invalidation deltas from **every** shard reaching into a subscription's read ranges must reach the node serving it (the range-intersection machinery is already shard-agnostic — the delta *transport* must become shard-complete).
8. **Client bracket safety**: Transitions per session applied in emission order with `startVersion` equality; any replacement for scalar `StateVersion.ts` must preserve resync-on-gap (`client-reducer.ts:38–41`).
9. **`_creationTime` stays globally meaningful and index keys stay unique** — it is baked into every index key and cursor (`kernel.ts:172`, `index-manager.ts:23–32`). Either decouple it from the shard line or keep lines comparable.
10. **Component co-commit**: `ctx.scheduler.*` / workflow journal writes share the caller's transaction (`facade.ts:214–241`) → component tables must be writable from every shard's transactions, i.e. sharded by caller-shard (with one driver per shard partition) — or the design must explicitly carve them out.
11. **Postgres-only substrate**: the safe-visibility protocol must be derivable from the shared database alone; per-commit coordination must not re-serialize writers (that's the whole point).
12. **Tier-0 identity**: with one shard `"default"`, every code path must reduce to today's behavior byte-for-byte; apps without `.shardKey` never observe sharding.

## MAY RELAX (with stated cost)

1. **The single global ts line → per-shard `(shardId, ts)` lines.** Cost: every scalar-ts surface becomes shard-qualified — `StateVersion.ts` (protocol.ts:17), `/_fleet/run` commitTs (forwarder.ts:104), action `maxCommitTs` (executor.ts:283–292), watermark (replica-tailer.ts:94), `maxTimestamp` (docstore/types.ts:127), the fanout payload (write-fanout.ts:11–16, must add shardId), oracle-per-runtime (runtime.ts:165). Protocol/wire changes + re-proving client resync. *Alternative*: keep one global allocation (PG sequence) and instead relax "allocation order = visibility order" — then a **safe frontier** (min in-flight allocated ts) must gate all reads/watermarks; cost = frontier maintenance per commit (cheap in PG: in-flight registry or per-writer high-water rows) + visibility latency bounded by the slowest in-flight transaction.
2. **"All ts ≤ watermark present" → per-shard watermarks** (needs an additive `shard_id` column on `documents`/`indexes`, or per-shard physical logs) **or a frontier-bounded pull** (`(closedFrontier_old, closedFrontier_new]` instead of `maxTimestamp()`). Cost: schema addition, or replication lag coupled to the slowest in-flight writer.
3. **`StateVersion.ts` = "latest commit ts reflected" → a node-local monotonic sequence** decoupled from commit ts. Cost: forfeits the deferred ts-based version-gap resync; RYOW tokens travel separately as `(shardId, ts)`.
4. **Global `by_creation_time` exactness across shards** → per-shard exact, cross-shard approximate (if `_creationTime` becomes wall-clock/hybrid). Cost: multi-shard creation-order pagination is a merge with clock-skew fuzz, not a single scan.
5. **Single deployment-wide advisory lock / single `fleet_lease` row / binary node role** → per-shard lock keys, shard-keyed lease rows, role-as-set, promotion order run per shard (`node.ts:426–434` parameterized). Cost: N locks/leases/monitors; drivers (scheduler, reaper) pinned to the shard owning their tables.
6. **Cross-shard notify ordering** (handler.ts:241–245 serializes per node): deltas from different shards may re-run a subscription in arbitrary interleave. Acceptable cost: each re-run reads consistent closed frontiers, and the "missed" shard's delta triggers another re-run — extra recomputation, never wrongness.
7. **`commitTs` as a JS `number` (2^53) at the fanout/protocol edges** (write-fanout.ts:50, runtime.ts:251, node.ts:545): tolerable to keep, but only alongside its shardId — the number alone stops identifying anything.

**The two sites that decide the design**: `replica-tailer.ts:207–262` (a watermark can only ever be safe over a gapless per-shard/frontier-bounded log) and `kernel.ts:172` (the ts line is user-visible data inside every index key — fix `_creationTime` semantics *before* forking the line, or the fork is observable in every app's documents).