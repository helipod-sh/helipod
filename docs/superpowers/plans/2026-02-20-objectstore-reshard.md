# Object-storage reshard (offline) — design + implementation plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development (executed SOLO this session — subagents
> are rate-limited until Jul 15, so the orchestrator implements + self-reviews + heavily tests each task
> directly, in place of the usual per-task/whole-branch reviewer agents. Called out honestly: this slice
> ships without the layered adversarial-review gate the rest of the arc had — compensated with heavy
> tests + explicit correctness reasoning, but a follow-up opus whole-branch review is owed once agents
> are available.)

**Goal:** `stackbase objectstore reshard --object-store <url> --dir <convex> --shards M` changes a STOPPED
object-storage deployment's shard count N→M. Unlike the fleet reshard (logical lanes over one store →
moves no rows), object-storage lanes each have their OWN physical log, so a doc whose lane changes
(`shardIdForKeyValue(doc[shardKey], N) ≠ …M`) has its current state PHYSICALLY MOVED between lane logs.
Jump-hash minimises the fraction that move, but the tool rewrites the affected lanes regardless.

**Why schema-dependent:** a doc routes by its table's SHARD KEY field value (`runtime.ts`'s
`resolveDocMutationShard` = `shardIdForKeyValue(doc[TableMeta.shardKey], numShards)`; a table with no
`.shardKey` → the "default" lane). So reshard MUST know each table's shard key — it loads the schema from
`--dir` (the same `loadConvexDir`→catalog the engine uses), and recomputes every doc's M-lane the exact
same way the write path does.

**Architecture (offline, non-atomic full rewrite):**
1. **Stopped-deployment gate.** Read each `shardIdList(N)` lane's manifest; refuse if ANY lane has a live
   lease (`writerId !== "" && now <= leaseExpiresAt`) — an online reshard straddling a shard-count change
   is out of scope (as for the fleet). Hard gate, no `--force`.
2. **Materialize all N lanes' current state** into memory: for each `shardIdList(N)` lane, `open` an
   `ObjectStoreDocStore` over a throwaway in-memory `SqliteDocStore` local, then `local.dumpCurrentState()`
   → `{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }` (latest non-tombstone rev per id +
   current index rows). (Read is non-destructive — the destructive rewrite is step 4.)
3. **Re-partition.** For each doc, `tableMeta = catalog.getTableByNumber(doc.id.tableNumber)`; `newLane =
   tableMeta?.shardKey ? shardIdForKeyValue(doc.value.value[tableMeta.shardKey], M) : DEFAULT_SHARD`. Group
   docs by `newLane`. Route each INDEX ENTRY to the same lane as the doc it points at (`value.docId`),
   keyed by `documentIdKey`; DROP `Deleted` markers (the fresh lanes start clean — a snapshot/current-state
   image needs no tombstones, and a dropped-doc's index entry has no live doc to route to).
4. **Rewrite the M lanes** (the non-atomic phase — see the crash-safety note): first DELETE every
   `s{shardId}/…` object for EVERY lane in `shardIdList(N) ∪ shardIdList(M)` (both the surviving/reused
   lanes, whose contents change, and the surplus lanes, which disappear). Then for each `shardIdList(M)`
   lane: `open` a fresh (empty → `createManifest`) `ObjectStoreDocStore` → `acquire` → `commitWriteBatch`
   the lane's re-partitioned `{documents, indexUpdates}` (as ONE unit — the commit re-stamps a fresh
   monotone ts per the lane's own counter; the doc's id/value/index-entries are preserved; a doc's carried
   `prev_ts` becomes a tolerated dangling pointer, exactly as a snapshot restore's does per Slice-5's
   `write("Overwrite")` no-FK finding) → `relinquish` → `close`. A lane with no docs still gets a fresh
   empty manifest (so a post-reshard node's `open` finds it).
5. **Update globals** `numShards = M` LAST (after every lane is rewritten) via `ensureGlobals`-style
   overwrite — the linearization point: a node booting after this reads M and sizes to M lanes.

**Crash-safety (honest):** object storage has NO cross-object transaction, so this is a NON-ATOMIC full
rewrite — a crash mid-step-4 leaves the bucket partially rewritten (some lanes new, some deleted, globals
still N). It is NOT resumable. The contract is the same every heavyweight reshard tool states: **run it
OFFLINE against a BACKED-UP bucket, and don't interrupt it.** (The fleet reshard was atomic because
Postgres has a transaction; the object store doesn't. Documented, not hidden.) The full current state is
read into memory FIRST (step 2), so the destructive phase is as short as possible and never races the read.

**Scope boundary:** ONLINE reshard (live writers) is out. HISTORY is dropped (the new lanes carry
current-state only, like a fresh snapshot — a reshard is a compaction point, matching the substrate's own
snapshot semantics). Sharded-table support requires the doc to carry its shard-key field (it does — it's a
normal field); the default lane always exists in both N and M (`shardIdList(k)[0] === "default"` for k≥1).

## Global constraints
- ee-gated (`@stackbase/objectstore-substrate` owns the reshard core; the CLI dynamically imports it, gated
  like `serve --object-store`). Engine/CLI never imports an S3 SDK.
- Stopped-gate is a HARD refuse (no `--force`); a live lease → a clear error naming the lane.
- Reuse verbatim: `ObjectStoreDocStore.open`/`commitWriteBatch`/`relinquish`, `readManifest`,
  `dumpCurrentState`, `ensureGlobals`, `shardIdList`/`shardIdForKeyValue`/`DEFAULT_SHARD`/`documentIdKey`.
  No new substrate primitive — only a new offline operation composed from them.
- `now` is caller-supplied (deterministic tests; no ambient clock in the substrate).

## Task R1 — `reshardObjectStore` core (materialize → re-partition → rewrite → globals)
**Files:** `ee/packages/objectstore-substrate/src/reshard.ts` (new); `src/index.ts` (export); tests.
- `interface ReshardObjectStoreOpts { objectStore: ObjectStore; toShards: number; now: number; shardKeyFor: (tableNumber: number) => string | null; makeLocal: () => SqliteDocStore; }` (`makeLocal` mints a throwaway `:memory:` local for materialization — injected so the substrate stays adapter-agnostic; `shardKeyFor` is the catalog lookup, injected so the core needs no schema loader).
- `async function reshardObjectStore(opts): Promise<{ fromShards: number; toShards: number; movedDocs: number; perLaneCounts: Record<string, number> }>`:
  1. `readGlobals` → `fromShards = N`. If `N === toShards` → still rewrite? NO — if N===M, it's a no-op with a clear "already at M shards" result (return early, no rewrite). Validate `toShards >= 1`.
  2. Gate: for each `shardIdList(N)` lane, `readManifest`; if held-and-live (`writerId !== "" && now <= Number(leaseExpiresAt)`) → throw `ReshardObjectStoreLiveError` naming the lane.
  3. Materialize: for each `shardIdList(N)` lane, `open({objectStore, shard, local: makeLocal()})` → `local.dumpCurrentState()`. Accumulate all docs + all index entries.
  4. Re-partition (per §Architecture step 3): group docs by newLane; group live index entries by their doc's newLane (drop Deleted). `movedDocs` = docs whose newLane ≠ their oldLane.
  5. Rewrite: delete all objects under each lane in `shardIdList(N) ∪ shardIdList(M)` (`list`+`delete`); then per `shardIdList(M)` lane, open-fresh + acquire + commitWriteBatch(its docs+index) + relinquish + close.
  6. `writeGlobals numShards = M` (overwrite). Return the summary.
- [ ] R1a Failing test (grow 1→3, embedded fs): seed a single-shard ("0") bucket... WAIT — a single-shard bucket uses shard "0", but reshard-to-3 uses shardIdList(3)=["default","s1","s2"]. So the SOURCE for a 1→N reshard is the "0" lane; for N>1 it's shardIdList(N). The tool must read `fromShards` from globals and use the RIGHT source lane ids: `fromShards === 1 ? ["0"] : shardIdList(fromShards)`. Handle this. Test: seed a numShards=1 bucket ("0" lane) via a real ObjectStoreDocStore committing docs whose (schema) shard-key routes them across 3 lanes at M=3; `reshardObjectStore(toShards: 3)` → the 3 lanes (shardIdList(3)) each contain exactly the docs that route to them at M=3, the "0" lane is gone, globals=3. Materialize each new lane → its docs are exactly right.
- [ ] R1b Failing test (shrink 3→1): from a 3-lane bucket → `reshardObjectStore(toShards: 1)` → all docs collapse to... M=1 uses ["0"]? or ["default"]? DECISION: keep the N=1 layout convention ("0") ONLY for a deployment that was BORN single-shard; a reshard-TO-1 should use "default" (shardIdList(1)=["default"]) for consistency with the multi-shard vocabulary — OR "0". PICK "default" (shardIdList(1)) uniformly for reshard output, and document that a reshard-to-1 bucket uses "default", not "0" (a reshard is a fresh layout). So reshard ALWAYS writes `shardIdList(M)` lanes (M≥1 → includes "default"), never "0". The "0" source is only read when fromShards===1-born. Reconcile the boot: `buildObjectStoreWriterNode`'s N=1 uses "0"; a reshard-to-1 writes "default" → a mismatch. RESOLVE in R2/the boot: after a reshard, numShards≥1 always → the multi-shard boot path (shardIdList) is used even for M=1. Simplest: reshard output is always shardIdList(M); a node booting a resharded bucket uses shardIdList(numShards) lanes (numShards could be 1 → ["default"]). Adjust `buildObjectStoreWriterNode` so numShards from globals drives shardIdList — but that changes the N=1 "0" convention. **DEFER this reconciliation to R2** (the CLI/boot integration decides), and in R1 make reshard output = `shardIdList(M)` uniformly. Test 3→1: the single "default" lane has all docs; s1/s2 gone; globals=1.
- [ ] R1c Failing test (refuse on live): a lane manifest with `writerId="w", leaseExpiresAt=now+30s` → `reshardObjectStore` throws `ReshardObjectStoreLiveError`, bucket UNCHANGED (no partial rewrite — assert the manifests/globals are untouched).
- [ ] R1d Failing test (index entries follow docs + values preserved): after a grow, materialize a new lane and assert an index_scan over a moved doc's table returns it (its index entry moved too), and the doc's value is byte-identical.
- [ ] R1e Implement. Build/typecheck/test green. Commit.

**Gate:** grow/shrink re-partition docs+index entries to the right `shardIdList(M)` lanes by shard key,
current state preserved, a live deployment refused with no partial effect.

## Task R2 — the CLI `objectstore reshard` command + the boot reconciliation
**Files:** `packages/cli/src/objectstore.ts` (new — `objectstoreCommand`); `cli.ts` (dispatch + help); the
substrate-module surface (add `reshardObjectStore` + error type); `boot.ts` (the N=1-vs-"default"
reconciliation — see R1b); tests.
- `stackbase objectstore reshard --object-store <url> --dir <convex> --shards M`: load the schema from
  `--dir` (`loadConvexDir` → the composed catalog, the same the runtime uses) → build `shardKeyFor`
  (`catalog.getTableByNumber(n)?.shardKey`) → dynamic-import + gate the substrate → `reshardObjectStore`
  → print a clear `✓ resharded N → M shards (moved D docs; per-lane: …); a node booting this bucket will
  use M lanes` summary; on a live-deployment/validation error → `✗ <message>` + return 1.
- **Boot reconciliation (R1b's deferred decision):** make `buildObjectStoreWriterNode` derive its lane
  set from the bucket's persisted `numShards` global (via `ensureGlobals`/`readGlobals`) rather than only
  `opts.shards`, so a resharded bucket (globals=M, lanes=`shardIdList(M)`) boots the RIGHT lanes — and a
  reshard-to-1 bucket (`["default"]`) is served correctly. Keep a truly-fresh single-shard deployment
  (never resharded, no `--shards`) on the shipped "0" lane for backward compat: only switch to
  `shardIdList` when `numShards > 1` OR the bucket's globals already say a `shardIdList` layout. (Concretely:
  if globals.numShards is set + the "0" lane's manifest is absent but a "default" manifest exists → use
  shardIdList; else the "0" path. Decide the cleanest detection in R2 against the real code.)
- Wire `case "objectstore": return objectstoreCommand(rest)` into `cli.ts` + a help line.
- [ ] R2a Test (arg parse + gate): `objectstore reshard` without `--shards`/`--object-store`/`--dir` →
      clear `✗` + exit 1. `objectstore <unknown>` → usage error.
- [ ] R2b Test (happy path, embedded fs): seed a multi-shard bucket (via a real multi-shard `bootLoaded`
      writing docs across lanes), run `objectstoreCommand(["reshard",…,"--shards","2"])` → exit 0, globals=2,
      lanes=shardIdList(2); then a FRESH `bootLoaded --shards 2` over the resharded bucket reads all the
      docs back (the boot reconciliation works end to end).
- [ ] R2c Implement + wire dispatch/help + the boot reconciliation. Build/typecheck green; existing CLI +
      objectstore-substrate tests unchanged. Commit.

**Gate:** the CLI reshards a stopped bucket end to end, and a node boots the resharded bucket at M and
reads all data; args validated; ee-gated; existing single-shard/multi-shard boot paths intact.

## Task R3 — E2E: reshard a bucket, a fresh serve at M reads everything
**Files:** `packages/cli/test/objectstore-reshard-e2e.test.ts` (or fold into R2b if a separate real-`serve`
process E2E is too heavy solo).
- fs-hermetic: a multi-shard writer commits docs spread across N lanes → stop it → `objectstore reshard
  --shards M` → a fresh multi-shard serve at M → every doc is readable and lands in its correct M-lane
  (assert via a bucket inspector that each doc's manifest lane matches `shardIdForKeyValue`). MinIO-gated
  variant if practical.
- [ ] R3a Implement (reuse the objectstore-boot/serve harness). Build/typecheck/test green. Commit.

**Gate (headline):** a stopped object-storage deployment resharded N→M comes back up at M with every doc
in its correct lane and fully readable — the object-storage analog of the fleet reshard, completing the
reshard story for both tiers.

## Self-review
- Delivers the object-storage reshard (the last deferred arc-tail item that was UNBLOCKED by multi-shard
  serve). ONLINE reshard + history preservation are out of scope (documented). NON-ATOMIC full rewrite is
  the honest contract (no object-store transaction).
- Reuse honored: `open`/`commitWriteBatch`/`relinquish`, `dumpCurrentState`, `readManifest`/`ensureGlobals`,
  the id-codec shard functions — no new primitive.
- Type consistency: `shardKeyFor(tableNumber) → string|null`; docs are `DocumentLogEntry`, index entries
  `IndexWrite`; lanes are `shardIdList(M)` `ShardId` strings; `now`/`leaseExpiresAt` ms-epoch.
- HONESTY: built + self-reviewed + heavily-tested SOLO (subagents limited); a whole-branch opus review is
  owed before this is considered as hardened as the rest of the arc.
