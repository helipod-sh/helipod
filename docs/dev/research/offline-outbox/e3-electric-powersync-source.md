# E3 Evidence (source-level): Electric + PowerSync — what a durable outbox actually is in their code

**Question this doc answers:** at the source level, how does PowerSync's durable upload queue actually work (entry schema, drain loop, retry, write checkpoints, multi-tab), and what — if anything — does Electric ship in-tree for the write path? Then: mechanism by mechanism, what a server-authoritative reactive engine with **no client SQLite replica** (ours) can and cannot borrow.

**Sources & method:** read directly from the cloned repos, cited as `.reference/<repo>/<path>:<line>`:

- `.reference/powersync-js` @ `6aef3ac7` (2025-10-16) — the official JS SDK monorepo.
- `.reference/electric` @ `9acd04f8` (2025-10-01) — sync service + TS client + website docs + examples.

One scope caveat up front: PowerSync's write-interception triggers and the checkpoint-application state machine live in **powersync-sqlite-core** (a Rust SQLite extension, a *separate repo not in this clone*). The JS SDK calls into it via `powersync_replace_schema` (`.reference/powersync-js/packages/shared-internals/src/client/BasePowerSyncDatabase.ts:378`) and `powersync_control` (`.reference/powersync-js/packages/shared-internals/src/client/sync/bucket/SqliteBucketStorage.ts:188-193`). Everything below about *those* two pieces is inferred from the JS side's bookkeeping and interfaces; claims about what's visible in TS are exact. The companion web-sourced doc is `docs/dev/research/client-sync/e2-electric-powersync-offline-first.md`; this doc is the code-level check on it, and the two agree everywhere they overlap.

"Our ts-gate" below = the Convex-style optimistic-drop contract mapped in `docs/dev/research/client-sync/e1-our-client-and-convex-reference.md` §2.3: apply overlay at initiation → replay on every server ingest → on failure drop now → on success drop only when a `Transition` with `endVersion.ts >= mutationTs` applies.

---

## 1. PowerSync: the upload queue, in code

### 1.1 What a queued write carries — `CrudEntry`

A queue entry is a **row diff, not an intent** (`.reference/powersync-js/packages/common/src/client/sync/bucket/CrudEntry.ts:29-81`):

| Field | Meaning | Notes |
|---|---|---|
| `clientId: number` | auto-incrementing local queue position | the FIFO key; SQLite rowid-sequence backed |
| `id: string` | id of the changed row | client-generated (their model requires client-side ids) |
| `op` | `PUT` / `PATCH` / `DELETE` | `PUT` = insert-or-replace with *all non-null columns*; `PATCH` = *only changed columns*; from INSERT/UPDATE/DELETE statements respectively (`CrudEntry.ts:15-22`) |
| `opData?` | the column values | |
| `previousValues?` | pre-image for UPDATE/DELETE | **opt-in** per table via `trackPrevious` (`CrudEntry.ts:47-51`) |
| `table` | which table | |
| `transactionId?` | same for all ops in one local transaction (`CrudEntry.ts:57-60`) | enables transactional upload grouping |
| `metadata?` | app-attached string, written via a magic `_metadata` column | opt-in `trackMetadata` (`CrudEntry.ts:62-68`) |

The queue itself is a plain SQLite table, `ps_crud`, drained strictly by `id ASC`. Per-table options that shape what lands in it (`.reference/powersync-js/packages/common/src/db/schema/Table.ts:18-26`): `trackPrevious`, `trackMetadata`, `ignoreEmptyUpdates`, `localOnly` (never queued), and — notable — **`insertOnly`** (`Table.ts:19,77`): a table whose writes go *only* into the queue and are not kept locally. That is a pure outbox primitive living inside a replica system — evidence that "queue without local table" is a recognized sub-case even for them.

**How writes get intercepted:** app tables are actually views over internal `ps_data__<name>` tables (`Table.ts:140-143`); the JS SDK serializes the schema and hands it to the core extension (`BasePowerSyncDatabase.ts:378`), which creates the views and the INSTEAD-OF-style triggers that populate `ps_crud`. The trigger SQL itself is in the Rust core repo, not visible here.

### 1.2 Draining: `getCrudBatch` / `getCrudTransactions` and the `complete()` contract

- `getCrudBatch(limit)` — `SELECT id, tx_id, data FROM ps_crud ORDER BY id ASC LIMIT ?+1`, with the +1 row peeked to compute `haveMore` (`.reference/powersync-js/packages/shared-internals/src/client/BasePowerSyncDatabase.ts:460-481`). May span/split transactions — documented as such (`packages/common/src/client/CommonPowerSyncDatabase.ts:252-271`).
- `getCrudTransactions()` — an async iterator; each step runs a recursive CTE that collects *contiguous rows sharing the head row's `tx_id`* (`BasePowerSyncDatabase.ts:488-527`), i.e. one local transaction at a time, wrapped in a `CrudTransaction` (`packages/common/src/client/sync/bucket/CrudTransaction.ts:7-24`).
- Both hand the app a `complete(writeCheckpoint?)` callback (`CrudBatch.ts:19-21`). Completing is what dequeues: `DELETE FROM ps_crud WHERE id <= lastClientId`, then — **only if the queue is now empty** — writes the checkpoint into `ps_buckets.target_op WHERE name='$local'`; if no checkpoint was supplied, it writes the `MAX_OP_ID` sentinel `'9223372036854775807'` (`BasePowerSyncDatabase.ts:533-549`, `packages/shared-internals/src/constants.ts:6`).

(Aside, in corpus honesty: `SqliteBucketStorage.getCrudBatch`'s own `complete` has the empty-check **inverted** relative to `BasePowerSyncDatabase.handleCrudCheckpoint` — it sets `target_op = writeCheckpoint` only if rows *remain* (`SqliteBucketStorage.ts:164-181`) vs. only if the queue is *empty* (`BasePowerSyncDatabase.ts:536-542`). The public API path is the latter; the former looks like a legacy internal duplicate. Not verified which paths still call it — flagging, not asserting a live bug.)

Queue observability is first-class: `getUploadQueueStats()` returns count and an estimated byte size (`SUM(cast(data as blob) + 20)`) (`BasePowerSyncDatabase.ts:445-458`; `packages/common/src/db/crud/UploadQueueStatus.ts`).

### 1.3 The upload loop — wake conditions, poison detection, retry

The SDK owns the loop; the app owns only one function. The `PowerSyncBackendConnector` interface is two methods, and the retry contract is stated in its doc comment: *"Any thrown errors will result in a retry after the configured wait period (default: 5 seconds)"* (`.reference/powersync-js/packages/common/src/client/connection/PowerSyncBackendConnector.ts:21-27`). Defaults: `retryDelayMs: 5000`, `crudUploadThrottleMs: 1000` (`packages/shared-internals/src/client/sync/options.ts:21-22`).

The loop (`.reference/powersync-js/packages/shared-internals/src/client/sync/stream/AbstractStreamingSyncImplementation.ts`):

- **Runs concurrently with the download stream**, both started by `connect()` (`:271-283`). It is not request/response coupled to downloads.
- **Wake conditions:** (a) any change to `ps_crud` — the bucket storage registers a table-update listener and fires `crudUpdate` (`SqliteBucketStorage.ts:34-40` → `:351-353`); (b) receipt of the *first sync line* after (re)connect, explicitly to flush writes made while offline (`:703-717`); (c) throttled re-poll after each drain pass (`:194-204`).
- **Drain pass** `_uploadAllCrud` (`:206-269`): under a `CRUD` lock, loop { peek head item (`nextCrudItem`, `SqliteBucketStorage.ts:127-133`) → call the app's `uploadCrud()` → repeat until empty }.
- **Poison/no-progress detection:** if the head item's `clientId` is the same as the previous iteration's, the app "uploaded" without calling `complete()` — the SDK logs a pointed warning (*"Make sure to handle uploads and complete CRUD transactions… The next upload iteration will be delayed."*) and throws to force a delay (`:224-234`). This is the only wedge detection; there is **no dead-letter queue in the SDK** — a permanently-failing upload retries every 5s forever, and every strategy beyond that (relax constraints / block / dead-letter / discard) is documented as the app's responsibility, implemented inside `uploadData`.
- **Error path:** catch → set `uploadError` on the observable `SyncStatus`, delay `retryDelayMs`, exit the pass if disconnected (`:250-262`). Uploads are therefore **at-least-once**: a network failure after the backend committed but before `complete()` ran will re-send the same entries. Dedup is entirely the backend's problem.

### 1.4 Write checkpoints — the observed-inclusion primitive, exactly

When a drain pass finds the queue empty, it calls `adapter.updateLocalTarget(() => this.getWriteCheckpoint())` (`:241-248`). `getWriteCheckpoint()` is one HTTP GET to the PowerSync service: `/write-checkpoint2.json?client_id=<clientId>` → an opaque `write_checkpoint` op id (`:185-192`) — the service marks the current replication-stream position for this client.

`updateLocalTarget` (`.reference/powersync-js/packages/shared-internals/src/client/sync/bucket/SqliteBucketStorage.ts:72-125`) is where the correctness care lives:

1. Only proceed if `$local.target_op` currently holds the `MAX_OP_ID` sentinel — i.e. there *were* local writes whose round-trip is unconfirmed (`:72-80`).
2. Snapshot `sqlite_sequence.seq` for `ps_crud` **before** the HTTP call (`:81-89`).
3. After the checkpoint returns, inside a write transaction: abort if `ps_crud` is non-empty **or the sequence moved** — a new local write happened during the round trip, so this checkpoint doesn't cover it; a fresh one is needed (`:93-116`).
4. Otherwise persist `target_op = <checkpoint>` (`:118-124`) and inject `NOTIFY_CRUD_UPLOAD_COMPLETED` into the sync core's control stream (`AbstractStreamingSyncImplementation.ts:688-690`).

Semantics of `target_op`: *the download stream must reach at least this op before the local database may be considered consistent/synced again*. The actual gate — "do not apply/publish a checkpoint whose op id < target_op; while `ps_crud` is non-empty, do not advance at all" — executes inside the Rust core now (via `powersync_control`), but the TS-visible bookkeeping above is unambiguous about the design: **`MAX_OP_ID` = "gate closed until a write checkpoint is acquired"; a concrete op id = "gate opens when downloads pass it."** This is the never-merge invariant: the client refuses to observe server state newer than its own unacknowledged writes, so it never has to rebase pending writes onto fresh server data.

### 1.5 Durability & multi-tab

- **Durability is free**: the queue is a SQLite table in the same local database as the data; reload/crash survival requires zero extra code. The wake-on-first-sync-line rule (`:708-717`) is what turns that persistence into an actual re-send after restart.
- **Multi-tab (web):** one `SharedWorker` owns the sync stream for all tabs; but `uploadData` is *app code* (auth tokens, fetch to the app backend), so the worker **RPCs the upload back out to the most-recently-connected tab** (`.reference/powersync-js/packages/web/src/worker/sync/SharedSyncImplementation.ts:441-465`). Mutual exclusion for the drain is a `navigator.locks` request named `streaming-sync-crud-<db>` (`.reference/powersync-js/packages/web/src/db/sync/WebStreamingSyncImplementation.ts:26-31`) — Web Locks give cross-tab exclusion for free. Dead-tab detection is also lock-based: each client holds a unique lock; the worker requests the same lock, and acquiring it means the tab is gone (`.reference/powersync-js/packages/web/src/db/sync/SharedWebStreamingSyncImplementation.ts:145-154`).

---

## 2. Electric: the write path is verifiably absent from the client — by design

### 2.1 The posture, from their own docs tree

`.reference/electric/website/docs/sync/guides/writes.md:31-33`: *"Electric does read-path sync. It syncs data out-of Postgres, into local apps and services. Electric does not do write-path sync. It doesn't provide (or prescribe) a built-in solution for getting data back into Postgres."*

**Verified negative:** `grep -rni "outbox\|optimistic"` across `packages/typescript-client/src` and `packages/react-hooks/src` returns zero hits. There is no queue, no overlay store, no retry loop anywhere in the shipped client. The write story is entirely in `docs/` + `examples/write-patterns/` + one experimental helper.

What the client *does* ship that the write path leans on:

- **`txids` on every change message** (`.reference/electric/packages/typescript-client/src/types.ts:134-146`): the Postgres transaction ids that produced the change ride the read stream — the hook TanStack DB's Electric collection uses to hold an optimistic overlay until the matching txid is observed.
- **`matchStream`/`matchBy`** in `@electric-sql/experimental` (`.reference/electric/packages/experimental/src/match.ts:12-60`): subscribe to a shape stream until a change message with a given operation and column value appears; resolves with the message; **rejects after a 60s default timeout** (`match.ts:16,37-43`). This is their observed-inclusion primitive as code: ~50 lines, marker-match rather than ordering-based.
- **Reconnect contract:** shape streams resume by `(handle, offset)`; on a 409 the server issues `must-refetch`, which wipes the shape's data and resets the state machine to Initial (`.reference/electric/packages/typescript-client/src/shape-stream-state.ts:27,215`, `shape.ts:260`, `client.ts:2271`). Consequence for any overlay layer: synced state can be *discarded and refetched from scratch at any time*, so pending-write state must live strictly outside it and be merged on read — which all four of their patterns do.

### 2.2 Pattern 3 (shared persistent optimistic state) — persistent overlay, **not** a durable outbox

The reference implementation (`.reference/electric/examples/write-patterns/patterns/3-shared-persistent/index.tsx`):

- Overlay = a valtio `proxyMap` keyed by a client-generated `write_id` UUID, mirrored to `localStorage` on every change (`:32-37,42-54`).
- Send = plain REST call carrying `write_id` in the payload (`:85-105`). **On any failure (non-ok or thrown), the optimistic entry is deleted immediately** (`:102-104`) — rejection UX is "your write disappears."
- Confirm = `matchWrite`: await `matchStream` on the shape for a change whose `write_id` column equals the local id (deletes match on row `id` instead, since a delete can't carry the echo column) — then remove the overlay entry (`:60-78`). The server must **persist a `write_id` column** for this to work; that's the schema tax of marker-based inclusion.
- Two sharp edges, visible in the code: (a) a `matchStream` timeout is swallowed (`:71-75` catch → return) *without* deleting the overlay entry — a leaked overlay if the echo never arrives; (b) **nothing re-sends after reload**: sends happen only inside event handlers (`:166-172`), so a pending write that survives reload in localStorage renders optimistically forever but is never re-attempted. The persistence is for *display continuity*, not delivery. This is the precise difference between a persistent overlay and a durable outbox, demonstrated in their own reference code.

### 2.3 Pattern 4 (through-the-DB) — the only real outbox in the Electric tree, and it's an example, not a product

`.reference/electric/examples/write-patterns/patterns/4-through-the-db/`:

- PGlite holds `todos_synced` (immutable, Electric-written), `todos_local` (overlay), a combined `todos` view with INSTEAD-OF triggers, and a **`changes` table — a genuine durable changelog** with `write_id` and `transaction_id` per row (`local-schema.sql:90-96`, trigger functions at `:104-` onward). The synced-side trigger deletes the matching local row when a row with the same `write_id` echoes back (`local-schema.sql:55-63`) — rebase-friendly: concurrent updates from other users don't clear your pending write.
- `ChangeLogSynchronizer` (`sync.ts`) drains it: NOTIFY-driven wake (`:44-49`), cursor `position` over `changes.id` (`:105-118`), groups by `transaction_id` and POSTs batches (`:123-141`); result classification is exactly three-valued — network error or 5xx → `retry`, 2xx → `accepted` (delete drained rows, advance cursor, `:160-167`), any 4xx → `rejected` (`:150-154`).
- `rejected` → `rollback()` = **`DELETE FROM changes; DELETE FROM todos_local;`** — wipe *all* pending state on any single rejection (`:173-178`), self-described as "extremely naive" in both the code comment and the guide (`writes.md:235`).
- Retry has **no backoff and no cap** in the example — `retry` just marks `hasChangedWhileProcessing` and loops (`sync.ts:88-92,95-97`).

The guide's own framing of the trade (`writes.md:225-237, 255-262`): through-the-DB sync loses the write's *context* — when a rejection arrives, the user interaction that produced it is long gone, so meaningful rejection UX is structurally harder than in an API-call pattern. And the overall philosophy (`writes.md:264-274`): conflicts are rare in practice; blunt strategies are "perfectly serviceable."

---

## 3. Consistency contracts on reconnect: PowerSync's checkpoint gate vs our ts-gate, mapped precisely

| Concern | PowerSync | Electric (pattern 3 / TanStack) | Ours (ts-gate, per e1 §2.3) |
|---|---|---|---|
| Pending-write store | `ps_crud` SQLite table, FIFO by `clientId` | localStorage overlay map (P3) / PGlite `changes` table (P4) | RequestManager in memory today; the outbox slice would add a durable store |
| Write's identity | queue position (`clientId`) + local `tx_id` | client `write_id` UUID echoed via a server column / Postgres `txid` | `requestId` (wire) + mutation commit `ts` |
| Observed-inclusion signal | server-issued **write checkpoint op id**, gated via `$local.target_op` (`SqliteBucketStorage.ts:72-125`) | **marker match**: change message where `write_id`/txid equals mine (`match.ts:55-60`) | **ordering**: `Transition.endVersion.ts >= mutationTs` |
| Granularity of the gate | **whole database**: no checkpoint applies while *any* write is unacknowledged — reads freeze at the pre-write snapshot | per-write | per-mutation, and only gates *overlay removal* — server state always advances |
| Merge/rebase obligation | **none, by construction** (never-merge: refuses newer server state until round-trip) | rebase on read (overlay reduced over synced rows, `3-shared-persistent/index.tsx:123-146`) | rebase on every ingest (replay optimistic updates over new server results) |
| Checkpoint acquisition cost | extra HTTP round trip per drain + rides the replication cursor (idle-cursor hazard — see e2 §2.4) | free (txid already on the stream) but requires echo column or txid capture in the API | free: the mutation response *is* the commit acknowledgment; commitTs is engine-native (missing only on the wire — e1 gap H8) |
| Race guard | `sqlite_sequence` before/after check — abort checkpoint if a write landed mid-flight (`SqliteBucketStorage.ts:89-116`) | none needed (per-write markers) | none needed (per-mutation ts; the race class doesn't exist) |
| Reconnect flush | upload loop woken by first sync line (`AbstractStreamingSyncImplementation.ts:703-717`) | none (P3) / NOTIFY + startup `process()` (P4 `sync.ts:44-49`) | to be designed: drain-on-connect before or alongside resubscribe |
| Delivery semantics | at-least-once; dedup = backend's problem | at-least-once (P4 retry) or at-most-once-ish (P3 drop-on-fail) | at-least-once unless we add engine-side `(sessionId, requestId)` dedup — **neither system solves this for us** |

The deep difference: PowerSync's gate exists because the client's **reads come from the local replica** — if it applied newer server state while local writes were pending, it would need CRDT-class merging, which is exactly what they refuse to do. Our reads come from the server; freezing them while an offline queue drains would be strictly worse UX than rebasing. So their crown-jewel invariant is the one mechanism we structurally *cannot* adopt — while their bookkeeping around it (`target_op` as "the ts my downloads must reach") is *isomorphic* to the ts-gate we already have: `MAX_OP_ID` sentinel ↔ "mutation in flight, gate closed"; concrete `target_op` ↔ `mutationTs`; "downloads passed target_op" ↔ `endVersion.ts >= mutationTs`. We get their primitive per-mutation, without the HTTP round trip, without the cursor dependency, and without the seq-check race guard.

---

## 4. Borrow / adapt / reject — mechanism by mechanism, for a no-replica engine

**Borrow nearly verbatim:**

1. **Queue ergonomics** — auto-increment FIFO key, transactional grouping, `haveMore` peeking, and above all the **`complete()` dequeue contract** (dequeue happens only when the app confirms; `BasePowerSyncDatabase.ts:460-527`). For us the entry is a *mutation call* (`fnPath`, args, `requestId`, enqueue time) rather than a row diff — the PowerSync-Convex integration already proved mutations-as-upload-endpoint (e2 §2.4), and row diffs are meaningless against a server that runs functions.
2. **Poison/no-progress detection** — "head of queue unchanged since last pass → warn loudly + back off" (`AbstractStreamingSyncImplementation.ts:224-234`). Cheap, catches the #1 integration bug (forgot to complete).
3. **Wake conditions** — on enqueue, on reconnect/first-server-frame, throttled between passes (`:194-204,703-717`; defaults 1s throttle / 5s retry, `options.ts:21-22`). The reconnect wake is what makes persistence into delivery — the exact piece Electric's pattern 3 is missing (§2.2b).
4. **Queue observability** — count + size + `uploadError` as first-class reactive status (`BasePowerSyncDatabase.ts:445-458`; `updateJsSyncState` uses at `:222,238,252`). An offline outbox without a visible "N pending, last error E" is undebuggable.
5. **Web Locks for single-drainer** — `navigator.locks` named per-database (`WebStreamingSyncImplementation.ts:26-31`). A shared IndexedDB outbox with per-tab WebSockets needs exactly this and nothing more; we do not need their SharedWorker (that exists to share one SQLite handle + one sync stream, a problem we don't have).
6. **`metadata`/`previousValues` as opt-in entry enrichment** (`CrudEntry.ts:47-68`) — reserve equivalent fields in our entry schema (app-attached context for rejection UX; pre-image for undo).

**Adapt:**

7. **Observed inclusion** — take the `target_op` idea but per-mutation via commitTs on `MutationResponse` (e1 H8) + the existing ts-gate. Electric/TanStack's marker-match is the fallback design for systems without a total commit order; we have one (single-writer OCC; the fenced-frontier work preserves per-ring ordering), so ordering-based is cheaper and needs no echo columns. Note the fan-out caveat already on file: a mutation that invalidates nothing the client subscribes to never advances that client's `version.ts` (e1 G4) — an outbox drain gate must handle that (empty ts-advancing Transition to the origin, or drop-on-`MutationResponse`).
8. **Retry/rejection split** — PowerSync's contract is "throw ⇒ transient ⇒ infinite 5s retry; semantic rejection ⇒ 100% app's problem, four strategies in docs, zero in SDK" (`PowerSyncBackendConnector.ts:21-27`; e2 §2.3). We can do strictly better because our server *deterministically reports* whether the mutation executed and failed (app error) vs. never ran (transport): auto-retry transport failures with backoff (theirs has none in the example code; the SDK's is fixed-delay), and on app rejection dequeue + surface to an app callback with the original entry (context preserved — the thing Electric says through-the-DB loses, `writes.md:255-262`). Default should be *skip-and-report*, not PowerSync's *block-forever* and not Electric-P4's *wipe-everything* (`sync.ts:173-178`).
9. **Exactly-once** — nobody ships it. PowerSync uploads are at-least-once with backend dedup unspecified; Electric P3/P4 give you a `write_id` you *may* dedup on server-side. For us: engine-side dedup on `(sessionId, requestId)` (or a client-supplied idempotency key on the mutation) is the missing piece both systems delegate — and it's cheap for us because the transactor is the single choke point.
10. **`insertOnly` as a product shape** (`Table.ts:19,77,122-124`) — their append-only, no-local-copy table is proof that "outbox, not replica" is a coherent standalone feature. Our version: a durable client-side mutation queue with reactive status, no local data model at all.

**Reject:**

11. **The whole-database checkpoint gate / never-merge invariant** (§1.4, §3) — requires reads served from a local replica. For us, blocking `Transition` application while queued mutations drain would freeze every live query to deliver a consistency property our users didn't ask for. We rebase (replay pending/optimistic mutations over each ingest) — the Convex-shaped answer our client half-implements already.
12. **Trigger-based write capture** (views + INSTEAD-OF triggers, `Table.ts:140-143` + the Rust core) — only meaningful when app code writes SQL against local tables. Our writes are already function calls; the interception point is the client mutation API, one line, no schema machinery.
13. **Uploading row diffs** — `PUT`-with-all-columns/`PATCH`-changed-columns (`CrudEntry.ts:15-22`) reintroduces last-write-wins column merging and forfeits server-side mutation logic (validators, authz, derived writes). Convex-shaped engines queue *intents*.
14. **The service-side write-checkpoint endpoint** (`/write-checkpoint2.json`, `AbstractStreamingSyncImplementation.ts:185-192`) and its seq race guard — solved problems for a per-drain checkpoint that our per-mutation commitTs never has.

**The one-sentence takeaway:** PowerSync shows what a production durable outbox's *plumbing* must have (durable FIFO + complete()-gated dequeue + wake-on-reconnect + poison detection + visible status + single-drainer lock) while its *consistency* mechanism is replica-only; Electric shows the write path can be fully delegated — but its own reference code demonstrates that a persistent overlay without a drain loop is not an outbox, and that observed-inclusion (by marker or by ts) is the one primitive every correct design converges on.
