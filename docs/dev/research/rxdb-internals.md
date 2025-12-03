# RxDB — Engine Internals (code-verified deep dive)

**Companion to [`rxdb.md`](rxdb.md)** (the docs-based overview). This is a **source-verified**, `file:line`
analysis of the two RxDB subsystems most relevant to Stackbase's performance backlog — the **replication
protocol** (backlog #13: optimistic updates + version-gap resync) and **EventReduce / reactive queries**
(backlog #12: client-side incremental query maintenance). Produced by a two-way parallel read of the
cloned source at `.reference/rxdb` (tip `d3e967f`, 2025-11-28). The headline: **RxDB's replication maps
onto Stackbase's MVCC log almost perfectly — and *simpler* than RxDB's own generic case.**

---

## 1. The replication protocol (backlog #13)

RxDB replicates a local "fork" collection to a "master" (any backend) via two independent loops sharing
one `state` object (`replication-protocol/index.ts:70-131`); they interleave only through shared RxJS
subjects + promise queues (`streamQueue.{up,down}`), never by calling each other.

### 1.1 The two loops

- **Downstream (pull)** `downstream.ts`: an `addNewTask()` enqueues either a `'RESYNC'` marker or a pulled
  `{documents, checkpoint}` batch. Three triggers: (1) an unconditional `RESYNC` at startup
  (`:134`); (2) `masterChangeStream$` live events, *delayed while an upstream push is active*
  (`:150-152`) so pull/push never race the same doc; (3) explicit `reSync()` (e.g. on reconnect).
  Batches funnel into `persistFromMaster()` (`:254-549`), which writes accepted docs to the fork + meta
  and advances the down-checkpoint.
- **Upstream (push)** `upstream.ts`: runs `upstreamInitialSync()` once at start (catch-up over everything
  the fork already has — offline writes, prior session), then `forkInstance.changeStream()` feeds ongoing
  writes into `persistToMaster()` (`:270-577`), which diffs against assumed-master-state, batches, calls
  `masterWrite`, and resolves conflicts.
- **Idle** (`awaitInSync`): `awaitRxStorageReplicationIdle` (`index.ts:159-181`) polls the two
  `streamQueue` promise references — if they're unchanged after an await, nothing new chained in ⇒ idle.
  `awaitInSync()` (`plugins/replication/index.ts:501-529`) waits for both directions' `firstSyncDone`,
  then loops the idle-check **twice** to catch a straggler racing the first check.

### 1.2 Checkpoints & "changes since"

A checkpoint is opaque; the default is `{id, lwt}` (`types/rx-storage.d.ts:310-313`) — the primary key +
last-write-time of the last doc returned. The "since" query (`rx-storage-helper.ts:898-943`) is the
canonical cursor: `_meta.lwt > sinceLwt OR (_meta.lwt == sinceLwt AND id > sinceId)`, **sorted
`[lwt asc, id asc]`** (the `id` tie-break lets a flat batch of same-`lwt` writes iterate
deterministically). Iteration (`downstreamResyncOnce`, `downstream.ts:174-216`) loops until a page returns
**fewer docs than `batchSize`** (end-of-stream). Checkpoints are persisted **not** in the data but as
dedicated rows in a **meta-instance**, keyed by direction (`'up'`/`'down'`) — so the two loops advance
independently (`checkpoint.ts:18-143`, serialized behind `state.checkpointQueue`, 409-retry on rev
clash).

### 1.3 The meta-instance & assumed-master-state (the load-bearing piece)

`meta-instance.ts` stores, per fork document, `docData` = **the last state believed to be on master**
(`getAssumedMasterState`, `:107-144`; written after every successful push/pull via `getMetaWriteRow`,
`:147-195`). This is the single source of truth for "what do we think master currently has," decoupled
from the fork's own `_rev` chain, and stored separately so writing it never triggers fork reactivity.
A per-row `isResolvedConflict` field holds the **`_rev` of the fork write that resolved a conflict** (not a
boolean) — this lets the loop tell "assumed-master already equals fork, skip" from "we just resolved a
conflict; that resolving fork write must still round-trip to master."

### 1.4 Conflict detection & resolution (optimistic CAS)

- **Detection** is optimistic compare-and-swap, *not* a version number. On push, each row is
  `{assumedMasterState, newDocumentState}` (`types/replication-protocol.d.ts:57-60`); the backend compares
  its actual current state for that id against `assumedMasterState` via **`conflictHandler.isEqual`** — the
  equality check *is* the CAS condition. Match (or no existing doc) ⇒ apply the write. Mismatch ⇒ **return
  the doc's actual current server state** in the output array; *presence in the returned array is the
  conflict signal* (not an HTTP error), matched back by primary key.
- **Resolution happens ONLY upstream, never downstream** (`conflicts.ts:20`; downstream always treats the
  incoming master doc as authoritative). `resolveConflictError` (`conflicts.ts:22-53`) calls
  `conflictHandler.resolve({newDocumentState, assumedMasterState, realMasterState})`, gives the result a
  fresh fork `_rev`, writes it to the fork, and stamps the meta row's `isResolvedConflict = resolved._rev`.
  That fork write flows out on the next tick, is recognized (its `_rev` matches `isResolvedConflict`), and
  pushed — closing the loop.
- **Default handler** (`default-conflict-handler.ts:8-34`): `isEqual` = `deepEqual` minus attachment bytes;
  `resolve` = **always return `realMasterState`** (server-wins, drop the local fork). Apps override
  `resolve` for field-level merges.

### 1.5 Guarantees, revisions, `_deleted`

- **Eventual consistency**, explicitly **at-least-once, not exactly-once**: checkpoint/meta writes aren't
  atomic with the master write, calls retry on error, and a crash mid-batch simply replays it. **Backend
  must be idempotent** — receiving the same `{assumedMasterState, newDocumentState}` twice is a no-op
  overwrite (the assumption still matches), not a duplicate-insert error.
- **`_rev` (`<height>-<token>`)** is a *local* fork write-counter + conflict nonce — **not shipped to the
  backend** by default (`helper.ts:53-68` strips it). Only when replicating against a `_rev`-bearing
  backend (CouchDB) is the height tracked in `_meta[identifier]` to skip full diffs.
- **`_deleted: true`** is a first-class field — deletes are tombstones replicated like any update (never
  physically removed, so peers see them in a since-query). **`_meta.lwt`** drives checkpoints + the default
  `isEqual`/sort.

### 1.6 The backend contract (deliberately tiny)

- **Pull** `masterChangesSince(checkpoint, batchSize) → {documents, checkpoint}` — up to `batchSize` docs
  strictly after the checkpoint, sorted by the checkpoint field (`[lwt, id]`), each `WithDeleted` (has
  `_deleted`, no `_meta`/`_rev` needed), plus a new checkpoint. Fewer than `batchSize` ⇒ "done." Optional
  `stream$` for live sync, able to emit `'RESYNC'`.
- **Push** `masterWrite(rows) → conflicts[]` — per row, CAS `assumedMasterState` vs actual; return actual
  state on mismatch.

### 1.7 Mapping to a Stackbase MVCC-log backend (the actionable part)

Stackbase's append-only log (`{ts, id, value, prev_ts}`) is a **near-perfect, and simpler, substrate**:

- **Pull handler:** checkpoint = the last-seen commit **`ts`** — a *single scalar* (globally unique per
  commit ⇒ no `id` tie-break needed, unlike RxDB's compound `{lwt,id}`). `masterChangesSince` = scan
  `entries where ts > checkpoint AND table/shard matches`, `ORDER BY ts ASC`, `LIMIT batchSize`, return
  `{documents, checkpoint: lastEntry.ts}`. **Tombstones already are `_deleted`** — no schema change. The
  live variant subscribes to the commit fan-out Stackbase already has, and emits `'RESYNC'` on WS
  reconnect after a gap.
- **Push handler:** `assumedMasterState` can be the doc's last-known commit **`ts`** (compare one integer,
  not a deep-equal). Server-side this is **Stackbase's existing OCC transactor read-set check generalized
  to one document**: read current committed `ts` for `id`; equal ⇒ commit `newDocumentState` (fresh `ts`);
  unequal ⇒ return the conflict payload with the real doc. *No new conflict mechanism* — just expose the
  transactor's existing conflict path through this API shape.
- **What's genuinely new (all client-side):** (1) a local optimistic **fork buffer** per doc so mutations
  apply instantly/visibly before ack; (2) a small local **meta-store** of `{assumed-ts, up/down
  checkpoints}` (IndexedDB, or in-memory for session-scoped optimism); (3) a `conflictHandler.resolve`
  policy (default server-wins); (4) **version-gap resync**: on WS reconnect or a detected sequence gap,
  re-run checkpoint-iteration pull instead of trusting the live stream — the direct analog of
  `downstreamResyncOnce()`, and the mechanism that makes resync *correct* rather than best-effort.

---

## 2. EventReduce & the reactive-query pipeline (backlog #12)

RxDB keeps a live query's result set current on writes **without re-running the query**, via the
`event-reduce-js@6` algorithm.

### 2.1 RxQuery lifecycle

`RxQueryBase` (`rx-query.ts:75-601`) holds one mutable `_result: RxQuerySingleResult` (`:120`) and
`_latestChangeEvent` (`:224`, a cursor into the collection's global change counter). `.$`
(`:149-212`) composes `collection.eventBulks$ → mergeMap(_ensureEqual) → map(read _result) →
shareReplay(1) → distinctUntilChanged(on _result.time)` — subscribers share one execution; unchanged
results (same `.time`) don't re-emit. `.exec()` and `.$` share the *same* recompute path (`_ensureEqual`),
so there's one source of truth. An **idle query is O(1)**: `_isResultsInSync` (`:653-660`) just compares
`_latestChangeEvent` to `changeEventBuffer.getCounter()`; if in sync, return immediately.

### 2.2 The change-event pipeline

Writes → storage change events → `RxDatabase.eventBulks$` (`rx-database.ts:249`) → per-collection stream →
`rxChangeEventToEventReduceChangeEvent` (`rx-change-event.ts:36-62`) converts to the event-reduce shape
`{operation: INSERT|UPDATE|DELETE, id, doc, previous}` (`previous` = `null` for INSERT, prior doc for
UPDATE/DELETE, or the literal `'UNKNOWN'` when an UPDATE lacks the previous doc — forcing conservative
handling). `ChangeEventBuffer` (`change-event-buffer.ts:27-168`) is a **fixed 100-entry ring buffer**
keyed by a running counter; `getFrom(pointer)` returns events after a counter or `null` if the pointer
fell off the back (**overflow ⇒ full re-exec**).

### 2.3 EventReduce: inputs, actions, application, fallback

`calculateNewResults` (`event-reduce.ts:101-168`) builds cached `QueryParams` per query — `primaryKey`,
`skip`, `limit`, `sortFields`, a total-order `sortComparator` (`rx-query-helper.ts:188-234`), and a
mingo `queryMatcher` — then for each buffered change event calls **`calculateActionName`** from
event-reduce-js. That function evaluates ~18 boolean state functions (did it match before? does it match
now? was the set at `limit`? did the changed field affect sort order?) through a **precomputed binary
decision diagram** over the ~2¹⁹ state space and returns one of ~16 **actions**: `doNothing`,
`insertFirst`, `insertLast`, `insertAtSortPosition`, `removeExisting`, `replaceExisting`, … and the escape
hatch **`runFullQueryAgain`**. For a non-`doNothing` action, `runAction` **mutates the cached result array
+ id-map in place** (splice-in at sort position, splice-out, resort). **If *any* event in a batch returns
`runFullQueryAgain`, the whole batch falls back to a real DB re-exec** (never a partial apply). Three
fallback triggers total: buffer overflow, `database.eventReduce === false`, and any `runFullQueryAgain`.

### 2.4 Determinism (the precondition)

"Insert at sort position N" is only well-defined under a **total, reproducible order**. `normalizeMangoQuery`
(`rx-query-helper.ts:171-178`) guarantees it by **appending the primary key to every sort** (and deriving
one from indexes if none given), so no two docs ever compare equal. `custom-index.ts` builds fixed-width,
padding-normalized indexable strings so on-disk index iteration matches the in-memory comparator exactly —
determinism enforced at both layers.

### 2.5 Query cache / dedup

`QueryCache` (`query-cache.ts`) is a `Map<canonical-query-string, RxQuery>` (key = `rxQuery.toString()`,
a `sortObject`-canonicalized JSON). Two structurally-identical queries share **one** `RxQueryBase`, one
`_result`, one pipeline, one EventReduce cost. Eviction runs only past 100 cached queries, skips queries
with live subscribers, evicts never-executed ones immediately, else oldest-by-`_lastEnsureEqual` — all on
an idle callback so it never adds latency to a hot query.

### 2.6 Mapping to a Stackbase client SDK (the actionable part)

A Stackbase client that receives server-pushed **row diffs** should maintain live-query results with the
*same* algorithm, not a re-run:

1. **Per live query, keep:** the normalized query (server's canonical form, **sort with the doc id
   appended**), a comparator + selector-matcher built once, `skip`/`limit`, the current ordered result
   array, and an `id→row` Map — this is exactly RxDB's `QueryParams` + `previousResults` +
   `keyDocumentMap`.
2. **Per diff frame**, convert to `{operation, id, doc, previous}` (mirroring `rx-change-event.ts`) —
   `previous` matters for UPDATE/DELETE; if the server can't cheaply supply it, send `'UNKNOWN'` and let
   the algorithm fall back conservatively.
3. **Feed each diff through `event-reduce-js`'s `calculateActionName`/`runAction` directly** — it's a
   small, dependency-free MIT package; don't reimplement insert/remove/resort. RxDB's own contribution on
   top is thin (batching, buffering, fallback).
4. **On `runFullQueryAgain` for any event, re-fetch the whole query fresh** — bounds worst-case to "extra
   round trip," never silent staleness.
5. **A monotonic per-query sequence is essential** (RxDB's `_latestChangeEvent` vs buffer counter): the
   server should stamp each subscription's frames with a version, and the client keeps a small gap buffer
   (~100) so a momentarily-missed frame reconciles without a full refetch — only refetch when truly out of
   the window. (This is the client mirror of the server-side subscription indexing in backlog #10.)
6. **Dedup identical live queries** by canonical string so components sharing a query share one
   incremental-maintenance instance.

---

## 3. How this lands in the backlog

| Backlog item | What RxDB gives us (code-verified) |
|---|---|
| **#13** Optimistic updates + version-gap resync | The complete protocol: checkpoint-iteration pull, optimistic-CAS push (`{assumedMasterState, newDocumentState}`), upstream-only conflict resolution, `RESYNC` on reconnect. **Server side is nearly free** — pull = "log entries since `ts`", push = the OCC transactor's read-set check per doc. New work is the client fork buffer + meta-store + resync-on-gap. |
| **#12** Client-side incremental query maintenance | Use `event-reduce-js` directly: normalized query (id-appended sort) → per-diff `calculateActionName`/`runAction` → in-place result update, with `runFullQueryAgain`/gap-buffer-overflow → full refetch. Requires a per-subscription version + a small gap buffer. |
| **#10** Server diff pushes | Confirms the client half: if the server pushes row diffs (inserts/deletes) with a `previous` and a per-subscription sequence, the client can maintain results incrementally — so #10 (server) and #12 (client) are the two ends of the same wire. |

**The convergence, now triple-confirmed in code:** SpacetimeDB (server IVM + indexed subscriptions + diff
pushes), RxDB (client EventReduce + diff-driven result maintenance), and our own fan-out benchmark all say
the same thing — **maintain result sets incrementally and ship diffs; never re-run the query.** Backlog
items #1/#10/#11 (server) and #12/#13 (client) are the two halves of building that.

## Sources

Two-agent parallel source read of `.reference/rxdb` (tip `d3e967f`): `src/replication-protocol/*`,
`src/plugins/replication/*`, `src/event-reduce.ts`, `src/rx-query*.ts`, `src/change-event-buffer.ts`,
`src/rx-change-event.ts`, `src/query-cache.ts`, `src/custom-index.ts`, `src/rx-storage-helper.ts`,
`src/types/{replication-protocol,conflict-handling,rx-storage}.d.ts`, and the `event-reduce-js` dependency.
See [`rxdb.md`](rxdb.md) for the docs-based overview and
[`spacetimedb-internals.md`](spacetimedb-internals.md) for the server-side incremental-maintenance
counterpart.
