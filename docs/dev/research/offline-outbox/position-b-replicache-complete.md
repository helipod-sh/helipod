# Position B — The Replicache-Complete Model

Position paper B in the durable-offline-outbox adversarial workflow. Thesis: ship the **complete
school-C design in one slice** — durable intent outbox + per-client dedup atomic with commit
(everything Position A ships) **plus** the four mechanisms that turn a queue into offline:
**client-supplied document ids** (id-codec acceptance), the **registry-by-`udfPath`** for reload
replay of optimistic updaters (the client-sync verdict's own named mechanism, verdict.md:152),
**placeholder-arg rewriting** as the bounded fallback for chains, and **full rebase-on-pull
semantics** (rehydrated intents rebuild their layers over the fresh baseline and drop through the
existing ts-gate, unchanged).

Code claims cite this tree (read 2025-11-04, branch `scheduler-component`, post-Gated-Ledger) or
the reference clones as `.reference/<repo>/<path>:<line>` (studied, never copied —
`.reference/README.md`). Prior-art syntheses cite the evidence corpus (e1–e5 in this directory),
whose primary citations I spot-verified where load-bearing (Replicache's missing-mutator stub,
`.reference/mono/packages/replicache/src/db/rebase.ts:44-59`; Zero's offline mutation rejection,
`.reference/mono/packages/zero-client/src/client/mutator-proxy.ts:84-121` — both confirmed
verbatim).

---

## 0. The one-sentence case

**A durable queue whose optimistic updaters are unserializable closures is not an offline
feature — it is a deferred-double-entry generator.** Persist the intent but not the ability to
*replay its UI*, and the reload-mid-offline user sees their edits vanish, re-does the work by
hand, and reconnect commits **both** copies. Position A ships the queue; only the registry, client
ids, and rebase make the queue *offline*. And every one of those three was already named as this
slice's receiving seam by the corpus that shipped S1–S4 — B is not scope creep; it is the verdict's
own deferred table, bought whole instead of in two app-breaking installments.

## 1. Why "queue-only" fails the user, concretely

Walk the flagship offline scenario under a Position-A client (durable S1 + server dedup, no
registry, no client ids):

1. **Offline, the user adds five items.** Each `mutation()` call persists its triple
   `(requestId, udfPath, args)` + seed (the S1 record, `packages/client/src/mutation-log.ts:14-33`)
   and applies its optimistic layer — the layer is the caller's captured closure
   (`mutation-log.ts:21-23`: "Looked up at replay, never serialized"; captured at
   `packages/client/src/client.ts:175`).
2. **The tab reloads** (user navigates, OS kills the tab, phone locks — routine, not exotic).
   The queue survives in IndexedDB. The closures do not — they were stack frames.
3. **Still offline, the app reopens.** Queries render from... nothing (no server) or a stale
   cache — either way, **none of the five items are visible**. There is no updater to rebuild a
   layer from, and the S4 invariant (correctly!) forbids persisting layers across sessions
   (`packages/client/src/delivery-policy.ts:2-7`).
4. **The user re-enters the five items.** Five more entries join the queue.
5. **Reconnect. The drain is flawless** — exactly-once, FIFO, dedup atomic with commit. Ten
   items commit. The dedup layer worked perfectly and the data is still wrong.

No server mechanism can fix step 3–4; it is a client-side replay-capability gap. Replicache's
architecture states the fix: intent is stored as `{mutatorName, mutatorArgsJSON}` and the mutator
is **looked up by name from a registry** at replay time
(`.reference/mono/packages/replicache/src/db/commit.ts:257-267`; rebase looks up `mutators[name]`
and stubs a logged no-op if the name is gone so the queue still advances,
`.reference/mono/packages/replicache/src/db/rebase.ts:44-59` — verified). Linear persists typed,
replayable transactions to IndexedDB and re-instantiates them via `fromSerializedData` on restart
(e4 §3.1). Electric's own pattern-3 reference code is the cautionary artifact from the other side:
a localStorage overlay that survives reload but has **no re-send and no replay** — "persistence
for display continuity, not delivery" (e3 §2.2). A ships the mirror-image failure: delivery
without display.

The same reload also kills the second offline staple, **create-then-edit**:

- Today's placeholders are barred from mutation args, and the mint is a non-decodable string
  `` `${entropy}:${table}:${n}` `` (`packages/client/src/optimistic-store.ts:82-86`) that
  `decodeDocumentId` rejects by checksum (`packages/id-codec/src/document-id.ts:83-106`). The
  verdict's honest-cost row: "Offline create-then-edit chains impossible; online apps await the
  create" (verdict.md:156). Offline, that await never resolves — the chain cannot even be
  *enqueued*.
- The natural way a chain arises is not exotic API use — it is **args built from rendered state**:
  `useQuery` shows the optimistic doc, the user taps it, the app calls
  `mutation(api.todos.toggle, { id: doc._id })`. Under A, that `_id` is a placeholder string and
  the enqueue must be rejected ("you can't edit a pending item" — a DX cliff) or rewritten later
  (the machinery PowerSync×Convex shipped and called "the most visible DX cost of the
  integration", e3 §4/e5 R4). School C's unanimous answer is client-generated real ids passed as
  args (Replicache/Zero doctrine, e2 §1.3; e5 R4 grid row C: "no temp ids exist anywhere").

**The strategic point:** if A ships first, apps get written against closure-updaters,
await-the-create id discipline, and promise-only failure surfaces. B's mechanisms then arrive as a
**second app-facing migration** — registry registration replaces call-site closures, id discipline
changes, failure handling moves to durable accessors — on top of a wire protocol and dedup-record
shape that may need reshaping (see §4.3). Shipping A is not shipping a subset of B; it is shipping
B's migration debt.

## 2. The design

### 2.1 Client architecture — what persists where

A pluggable `OutboxStorage` seam (mirroring the `DatabaseAdapter`/`BlobStore` seam discipline —
CLAUDE.md locked decision; the client uses **no persistence API today**, e1 §5, so this is the
first storage abstraction in `packages/client`). Shipped adapters: `indexedDBOutbox()` (browser)
and the implicit in-memory default that preserves today's exact semantics byte-for-byte. Offline
capture is **opt-in constructor configuration** — no adapter, no behavior change (see §7 for why
this dial matters).

Persisted:

| Record | Contents | Why |
|---|---|---|
| client identity | `clientId` (random 128-bit, minted once per origin+deployment), deployment stamp, cached `tableNumbers` map (from the Connect handshake, §2.5), schema/app version stamp | Stable per-client identity across reloads — the thing `requestId` (an in-memory counter resetting to 1, `client.ts:48,168`) can never be; version stamp gates hazard #10 |
| outbox entries | `seq` (explicit persisted ordering column — Map insertion order does not survive IndexedDB, e1 §1.1), `requestId`, `udfPath`, `args` (already wire-shape `JSONValue`, converted at `client.ts:170`), **`seed`** (`{entropy, now}`, `mutation-log.ts:24-26` — must persist or minted ids change identity across reload, e1 §1.1), `identityFingerprint` (stamped at enqueue), `enqueuedAt`, `status` (alphabet extended: `unsent | parked | inflight | completed | failed{error, at}`), `idRefs` (§2.3) | The serializable triple S1 was built to persist (`mutation-log.ts:5-8`) plus the fields the hazards demand |

**Not** persisted, by design: the `update` closure (registry-resolved, §2.2), `touched`
(recomputed free on every recompose, `packages/client/src/layered-store.ts:126-152`), and any
optimistic **layer** — the S4 rule "no layer of any kind crosses a session"
(`delivery-policy.ts:2-7`) is *kept*, not relaxed; layers are always rebuilt from intents against
the fresh session's baseline.

**Enqueue stays synchronous.** `mutation()`'s sync initiation path (`client.ts:163-194`: apply
layer, listeners fire, then send) is untouched; the IndexedDB append is write-behind. The
discipline that bounds the crash window: an entry may not transition to the wire
(`unsent → inflight`) until its append has committed — so the only losable state is
*never-sent-and-not-yet-durable* (safe: nothing exists anywhere), never *sent-and-forgotten*
(the double-apply shape; the server dedup covers even that, but the discipline keeps the client's
`seq` accounting dense). Replicache accepts a ~1 s persist-scheduler window
(`.reference/mono/packages/replicache/src/replicache-impl.ts:144-148`, e2 §1.2); we can promise
strictly tighter because our entry is one small record, not a DAG chunk graph.

**The registry-by-`udfPath`.** `client.registerOptimistic(udfPath | ref, update)` — one
registration per mutation path, typically at module scope next to the codegen'd `api` object (a
codegen-adjacent `withOptimisticUpdate`-at-definition sugar is the DX follow-on). At rehydrate,
each entry resolves its updater by `udfPath`; a missing updater gets a **logged no-op stub and the
queue keeps moving** — Replicache's exact policy for renamed mutators
(`.reference/mono/packages/replicache/src/db/rebase.ts:44-59`), which degrades gracefully to
Position A's behavior (delivery without display) *per-mutation* instead of failing the queue. The
call-site closure API (`opts.optimisticUpdate`, `client.ts:161`) remains for online-only use;
docs state plainly that closures do not survive reload and offline apps should register.

**Rebase on reconnect** (the full Replicache pull-rebase mapped onto our session machinery —
`.reference/mono/packages/replicache/src/sync/pull.ts:304-434`'s drop-consumed → replay-survivors
→ atomic-swap, where our "separate head + swap" is the recompose pass that already publishes
atomically):

1. Transport reopens → `SetAuth` replay (unchanged, `client.ts:335-337`).
2. **`Connect` handshake** (§2.5): client sends `clientId` + the seqs of its parked/inflight
   entries + `ackedThrough`; server answers with the dedup records it holds:
   `{seq, status: applied|skipped, commitTs, value?/valueMissing?}` per hit.
3. Entries with `applied` records become `completed{commitTs}` using the **original** commitTs;
   entries with `skipped` records settle terminal (`failed`) and fire the durable failure surface
   (§2.4, R9). The client's seq counter reseeds above the max known seq — Lunora's
   reload-counter-reset lesson (`.reference/lunora/db/src/define-mutators.ts:115-119`;
   `lunora-client.ts:887-903`: a stale/zero seq is silently swallowed as a replay otherwise).
4. `resync()` resubscribes every live query; the reply is adopted as the fresh baseline
   (unchanged, `client.ts:297-310`).
5. **Rebuild layers oldest-first** for every surviving *and* every `completed`-but-ungated entry,
   via the registry, over the fresh baseline — one recompose publish, no flicker. `completed`
   entries then drop through the **existing, unchanged gate**: `versionCoversCommit(commitTs)`
   (`packages/client/src/reconcile.ts:25-27`) when the session's own feed covers their commit.
   This is the design's quiet win: **resume introduces zero new gate semantics.** A
   handshake-acked mutation is indistinguishable from a live-acked one to the reconciler — same
   status, same predicate, same drop path. (On fleet, where a lagging serving node could hand a
   baseline that predates the commit, the layer covers the gap until the G4 frontier machinery
   advances `version.ts` — `packages/sync/src/handler.ts:288-294` — exactly as it does for live
   forwarded mutations today. No new mechanism.)
6. **Drain survivors FIFO**, head-of-line: send, await `MutationResponse`, advance. One RTT per
   mutation in v1 (Lunora pays the same for ordering, e4 §1.5); batched drain rides the shipped
   group-commit path (Fleet B4, `packages/docstore/src/types.ts` `commitWriteBatch`) as a
   measured follow-on (R10).

Wake conditions and hygiene, borrowed from the PowerSync plumbing that E3 marked
"borrow-verbatim": drain on enqueue, on reconnect/first server frame, throttled re-poll;
head-unchanged-across-passes poison detection
(`.reference/powersync-js/packages/shared-internals/src/client/sync/stream/AbstractStreamingSyncImplementation.ts:224-234`);
first-class queue stats (`BasePowerSyncDatabase.ts:445-458`); distrust `navigator.onLine`
(always-attempt + interval nudge, `.reference/lunora/db/src/internals.ts:235-272`).

**Multi-tab.** One Web Locks leader (`stackbase:outbox:<origin>:<deployment>`) hydrates and
drains (Lunora's shape, `.reference/lunora/lunora-client.ts:2688-2734`); BroadcastChannel nudges
follower tabs' pending-accessor views. The lock is an **efficiency mechanism only — correctness
rests entirely on the server dedup records** (Lunora's stated doctrine, `:2690-2692`;
Replicache goes further and runs with no election at all because the LMID makes duplicate senders
no-ops, `.reference/mono/packages/zero-client/src/client/mutation-tracker.ts:341-346`). Entries
enqueued in tab A are visible to tab B's accessors via the shared IndexedDB and drain even if A
closes (R7). Cross-tab *rendering* of another tab's pending write is scoped out of the slice with
justification (layers are closures over per-tab subscription state) — but note that only B's
registry makes it *possible* later; under A it is structurally unreachable.

### 2.2 Client-supplied document ids — the id-codec assessment, honestly

The mechanism: `placeholderId(table)` is **promoted** to mint real, decodable `DocumentId`s. Same
API name, same determinism contract (per `(entry, table, call-ordinal)`,
`optimistic-store.ts:63-67`) — the 16 internal-id bytes derive deterministically from
`hash(seed.entropy, table, ordinal)` instead of concatenating strings, and the table number comes
from the handshake-cached `tableNumbers` map. The args ban lifts: minted ids are real, appear in
rendered state as real `_id`s, and flow into subsequent mutations' args untouched. The
create-then-edit chain needs **no id mapping, no rewrite, no await** — and it survives reload
because the seed persists (§2.1), which is exactly the property AC4.2 says kills in-memory id
maps.

Server-side cost, measured against the shipped code:

- **`db.insert` accepts an optional explicit id.** Today `handleDbInsert` mints unconditionally:
  `newDocumentId(tableNumber)` at `packages/executor/src/kernel.ts:328` (16 random bytes,
  `packages/id-codec/src/document-id.ts:59-67`). The change is small and self-validating by
  existing machinery: decode (checksum verifies, `document-id.ts:104`), table check
  (`isValidDocumentId(id, expectedTableNumber)` already exists, `document-id.ts:116-120`),
  **not-exists check** (one pk `txn.get` inside the transaction — the same read `handleDbReplace`
  already does at `kernel.ts:349`), then use the supplied internal id instead of minting. Perhaps
  twenty lines across `kernel.ts:321-340`, the guest `insert` signature
  (`packages/executor/src/guest.ts:102-104`), and the typed server API.
- **Sharding is unaffected.** Rings are chosen by the canonicalized, jump-hashed shard-key *value*
  (`packages/executor/src/executor.ts:270`), not by the document id — client-minted ids do not
  perturb one-doc-one-ring routing.
- **Security, stated precisely.** Ids were never capabilities: they are random 128-bit values and
  access is gated by authz read policies at the syscall layer (`kernel.ts:311-317`), not by id
  secrecy. What changes: a malicious client can now *choose* ids. Overwrite is blocked by the
  not-exists check; cross-table forgery by the table-number check; and "squatting" a victim's
  future id requires predicting 128 random bits — infeasible. The honest residual: any app that
  (wrongly) treats id knowledge as authorization loses nothing it actually had, but the docs must
  say so out loud. System tables (`_storage` et al.) refuse client ids outright.
- **The table-number map is the real coupling cost.** Codegen does not emit table numbers (they
  are allocated by the runtime's registry, not statically knowable — verified: zero
  `tableNumber` references in `packages/codegen/src`), so the client receives the map in the
  `ConnectAck` and caches it durably. Staleness is bounded by shipped invariants: the deploy gate
  *rejects* table-number changes (additive-only schema rule, CLAUDE.md slice 6b), so a cached
  number is never wrong — merely possibly missing for a table added after the cache was written,
  in which case the mint fails with a clear error. A truly-fresh client that has never connected
  cannot mint — and also has no app data to edit; stated as a documented boundary, not hidden.
- **A determinism bonus:** today an OCC replay of a conflicted mutation re-runs `handleDbInsert`
  and mints *fresh* random ids inside the transaction (`kernel.ts:328` →
  `crypto.getRandomValues`, `document-id.ts:61`). Client-supplied ids make insert replay-stable —
  strictly less nondeterminism inside the transaction, in the direction the syscall ABI's
  determinism rules already point.

### 2.3 Placeholder-arg rewriting — the bounded fallback, not the path

With client ids as the blessed mechanism, one class remains: apps (or surfaces) still on
server-minted ids — system tables, apps mid-migration, code that never registered for client
minting. For them, an entry records `idRefs`: the JSON paths in `args` holding placeholder
strings, detectable with zero ambiguity because today's placeholder format
(`optimistic-store.ts:85`) fails `decodeDocumentId`'s checksum while real ids pass. On the
create's ack, the outbox maps placeholder→real id (the `MutationResponse` value carries it),
rewrites dependent entries' args, and **re-persists before the dependent send** (E5 AC4.3(ii)
verbatim). This is precisely the machinery PowerSync×Convex rated their #1 DX cost (e5 R4) —
which is why B ships it as the safety net and steers the DX to client ids, where the class is
empty. Under A this machinery is not a fallback but the *only* chain mechanism, carrying its
full DX weight forever.

### 2.4 The server contract — where designs die

**The record.** A reserved core system table `_client_mutations` — **core, free-tier, both
docstores**; reusing fleet's `ee/` table would be a licensing and layering mistake (e1 §2.2:
outbox dedup is core reliability; CLAUDE.md: single-node self-host free forever). Row:

```
(identity, clientId, seq) PK → { commitTs, status: "applied" | "skipped",
                                 valueJson? (64KB cap), error?, createdAt }
```

Identity-scoped keys are Lunora's forgery rationale adopted verbatim: `clientId` is
client-supplied and unauthenticated; without identity in the key one user could suppress
another's sequence (`.reference/lunora/durable/src/ctx-db-client-watermark.ts:6-12`; anonymous
clients key as `("", clientId)`).

**Atomicity with commit — riding the proven channel.** The write is issued by a commit guard
inside the same store transaction as the mutation's effects. Every link except one already
exists and is exercised end-to-end by Fleet B3: `RunOptions.commitMeta` →
`RunInTransactionOptions.commitMeta` (`packages/transactor/src/types.ts:103`) → the transactor
threads it uniformly regardless of store (`packages/transactor/src/shard-writer.ts:369-371`) →
`DocStore.commitWrite`'s `opts.meta` → the guard's `CommitGuardUnit[]` — and `CommitGuardUnit`
is **already a core type** (`packages/docstore/src/types.ts:89-96`), with the batch-shaped
`setCommitGuard` live on `PostgresDocStore`
(`packages/docstore-postgres/src/postgres-docstore.ts:89-94`) and B3's guard proving the
atomic-INSERT-aborts-commit semantics (`ee/packages/fleet/src/node.ts:911-973`).

The one missing link, priced honestly — this resolves e1's flagged open unknown: **SQLite has no
commit guard today.** The meta is threaded but explicitly ignored ("SQLite has no commit guard,
so per-unit `meta` is ignored", `packages/docstore-sqlite/src/sqlite-docstore.ts:159-165,174`).
The slice adds `setCommitGuard` to `SqliteDocStore` — a synchronous callback inside its existing
commit transaction, structurally simpler than the Postgres one (single writer, one connection).
New work, not a swap; roughly the size of the Postgres guard hook. Without it, the free-tier
default deployment has no dedup at all (`node.ts:962-963`), which is disqualifying for any
position — A pays this too.

**Classification before the handler** (the Lunora three-way, minus the branch that doesn't
survive sharding — next paragraph): on a `Mutation{clientId, seq}`, the handler point-looks-up
`(identity, clientId, seq)` (the same pre-SELECT shape as `/_fleet/run`'s replay check,
`packages/cli/src/http-handler.ts:202-204`):

- **Hit, `applied`** → ack without running: `MutationResponse{applied: false, ts: originalCommitTs,
  value | valueMissing}` — the original commitTs is what keeps the client's ts-gate sound
  (AC2.1); `valueMissing` reuses B3's worked answer for the value-cache crash window
  (`ee/packages/fleet/src/lease.ts:89-99`).
- **Hit, `skipped`** → structured terminal failure, again without running.
- **Miss** → run with `commitMeta = {identity, clientId, seq}`; the guard INSERTs the record at
  the unit's own ts; a concurrent-duplicate PK collision aborts the loser, which re-reads the
  winner's row and replays it (B3's 23505 loser-reads-winner pattern,
  `http-handler.ts:73-90,238-240`).

**Sharding — resolving E5's named tension (AC2.3), not hand-waving it.** A single global
per-client watermark row must live on one ring; committing it atomically with effects on *other*
rings would recreate exactly the cross-ring write coupling B2a removed. B's resolution: **exact-
match per-seq records written on the ring that commits the mutation**, made correct by a shipped
invariant — mutation routing is *deterministic in the args* (canonicalized shard-key value,
jump-hashed, `executor.ts:270`), so a resend of the same `(udfPath, args)` lands on the same
ring and finds its record. Each record is one document on one ring: one-doc-one-ring holds. The
disclosed trade: we give up Lunora's server-side gap rejection (`409 OUT_OF_ORDER`,
`.reference/lunora/durable/src/shard-do.ts:3456-3468`) — **ordering becomes a client obligation
during drain** (never pipeline past an unacked head), while online pipelined mutations from one
client stay concurrent and unordered exactly as today (no regression, and no head-of-line
blocking imposed on the online path — the cost Lunora pays globally, e4 §1.5, we pay only while
draining). The AC that matters stays observable and testable: no resend interleaving
double-applies, across shards and `/_fleet/run` (AC2.3/2.4 — on fleet, the guard runs at the
owning shard's commit point, B3's install site `node.ts:916`, so a resend arriving via a
different node still dedups). The `ConnectAck` lookup for a handful of seqs is a cross-ring
*read* — point lookups by PK, the cheap direction; only writes are ring-bound.

**Poison pills — skip-and-record, Replicache's rule with our engine's classification.** During
drain, a permanent failure (argument/document validation, authz denial, handler throw) is
recorded `{status: "skipped", error}` **as its own durable commit through the transactor** —
advancing past the entry exactly as a success would — and returned as a structured terminal
failure; the client settles the entry `failed` and surfaces it through the durable accessors
(R9). Transient failures (OCC conflict beyond the executor's internal retries, transport) record
nothing and retry with backoff. Two honest notes: (a) handler-throw-during-drain defaults to
*permanent* — Replicache's stance ("the server must still mark the mutation as processed",
`.reference/mono/packages/replicache-doc/docs/reference/server-push.md`, their word for the
alternative is "deadlock"), automated by Zero's error-mode
(`.reference/mono/packages/zero-cache/src/services/mutagen/mutagen.ts:196-262`, whose comment
block argues app-vs-infra error is undecidable in general — the app re-enqueues from the failure
surface if it disagrees); (b) the classification split reuses the retryable-check discipline the
scheduler slice already learned (memory: runtime-validation follow-up).

**Retention — bounded, not vibes.** Three mechanisms: (1) the `Connect` handshake's
`ackedThrough` prunes records the client has fully gated (the normal path — O(queue) rows live
per client); (2) a fallback TTL, default **30 days** (vs B3's 1-hour sweep,
`ee/packages/fleet/src/lease.ts:84-87`, sized for seconds-scale forward retries — e1's distance
table names this exact gap; 30 days also matches the honest client-side ceiling, hazard #2);
(3) an orphan sweep for clients that never return, as a driver on the shipped recurring-driver
seam (the `storageReaper` pattern). A swept record re-executes on a post-TTL resend — the same
documented boundary B3 accepts (`lease.ts:85-86`), now with a window sized to the product
promise.

### 2.5 Wire protocol changes — all additive

`parseClientMessage` is a bare `JSON.parse` (`packages/sync/src/protocol.ts:73-75`) and the
protocol doc declares versioned-by-shape extensibility (`protocol.ts:7-9`); every change below
is an optional field or a new message type, backward-compatible by construction:

- **`Connect` is activated** — it exists and is a handler no-op today
  (`protocol.ts:44` / `packages/sync/src/handler.ts:196-198`), the verdict's reserved seam
  (verdict.md:155). Becomes
  `{type:"Connect", sessionId, clientId?, outstanding?: number[], ackedThrough?: number}`.
- **New `ConnectAck` server message**:
  `{results: [{seq, status, commitTs?, value? | valueMissing?}], tableNumbers: Record<string, number>}`.
  Also the seq-reseed echo (hazard #8).
- **`Mutation` gains `clientId?, seq?`** (`protocol.ts:46`). Absent → today's exact behavior
  (no dedup, `handler.ts:269-301` unconditional) — old clients, and clients without an outbox
  adapter, are untouched.
- **`MutationResponse` gains `applied?: boolean`** (false = replay ack) and a
  `skipped`-terminal variant; replay acks carry the **original** commitTs (the existing `ts`
  field and its send-site invariant, `protocol.ts:57-66`, `handler.ts:172-189`).

Feature detection falls out for free: a client that never receives `ConnectAck` is talking to an
old server and keeps today's S4 fail-fast policy — the park-and-resend swap arms only when the
server proves dedup exists, which is exactly the condition S4's own comments set
(`delivery-policy.ts:10-11,19-20`: "no server dedup exists — yet").

## 3. Migration from S1–S4 — what changes, what is additive

| Seam | Today | Under B | Nature |
|---|---|---|---|
| S1 `PendingMutation` | in-memory Map (`mutation-log.ts:37`), triple + seed + closure | same record + persisted `seq`/identity/timestamps/status extensions; storage-backed behind `OutboxStorage` | **Additive** — `requestId` stays the opaque string the record was designed around (`mutation-log.ts:15-16`); the seed was already mandatory to persist (e1 §1.1) |
| S2 layered store / recompose | rebuild layers over every ingest | unchanged — rebase-on-reconnect IS the existing recompose path; only the updater's *source* changes (closure → registry lookup) | **Unchanged mechanism** |
| S3 `versionCoversCommit` | `commitTs <= maxObservedTs && commitTs > 0` (`reconcile.ts:25-27`) | **unchanged predicate** — handshake-acked entries enter `completed{originalCommitTs}` and drop through the same gate at the same two call sites (`reconcile.ts:133,161`) | **Unchanged** — the isolated-predicate design (`reconcile.ts:5-6`) receives the lmid-shape *without needing to change* |
| S4 `closeDisposition` | `inflight` → reject + drop (`delivery-policy.ts:40-59`) | `inflight` → **park** (layer drops per the unchanged no-layer-crosses-a-session rule; intent retained); `MutationUndeliveredError` retired when dedup is proven, kept as the no-adapter/old-server fallback | **The named swap** (verdict.md:152), armed by feature detection |
| `placeholderId` | non-decodable string, barred from args (`optimistic-store.ts:82-86`) | same signature, mints real `DocumentId`s; ban lifted | **API-compatible promotion**; the temp-id swap machinery in recompose simplifies away |
| Wire | `Mutation{requestId, udfPath, args}` (`protocol.ts:46`) | + optional `clientId`/`seq`; `Connect` activated; `ConnectAck` added | **Additive by construction** |
| Server sync path | zero dedup (`handler.ts:269-301`) | pre-check + commitMeta + guard on both docstores | **New core work** (the priced bill, verdict.md:152) — identical under A and B |

Nothing reopens the §(c) reconcile algorithm — the property that won C the client-sync verdict is
preserved: B's additions land in the updater-resolution step, the id mint, and the status
alphabet, not in the gate.

## 4. Scope: one slice vs follow-ons — and the cost of A-then-B

### 4.1 In the slice

The server bill (identical for A and B — dedup records, both-docstore guards incl. the new SQLite
hook, wire fields, classification, retention, poison, the E2E matrix) plus B's four client-side
mechanisms: durable `OutboxStorage` + IndexedDB adapter; clientId/seq + handshake; park-and-
resend; drain with poison classification; **registry + rehydrate rebase**; **client-supplied ids**
(kernel + placeholderId promotion + handshake table map); **placeholder-rewrite fallback**;
R9 accessors (`pendingMutations()`/`usePendingMutations`/`onMutationFailed` — the bill verdict.md:153
named "purely additive later over S1"; the outbox makes it *due*, R9); Web Locks leader; retention
sweep. Flagship E2E per AC11.2: the same app offline-queue → reload → reconnect → exactly-once
drain on (a) single-binary SQLite and (b) Postgres + fleet + 8 shards.

### 4.2 Follow-ons, each with its seam

O(ack) session resume for *subscriptions* (R6 — `Connect` later carries `maxObservedTimestamp`;
AC6.3 holds: nothing above depends on it); batched drain riding group commit (after measuring
sequential v1 — R10); Background Sync SW drain (Chromium-only enhancement, hazard #14);
fs/SQLite outbox adapter for Node/Bun clients; cross-tab optimistic rendering (possible only
because of the registry); pending-row metadata channel; codegen `withOptimisticUpdate`-at-
definition sugar.

### 4.3 Why not A-then-B

The marginal code of B over A is small against the shared server bill — a registry map and
rehydrate loop; ~20 kernel lines + a handshake field for client ids; a bounded rewrite pass. The
marginal *cost of deferring* is not small, because all three deferred pieces are **app-facing**:

1. Apps written against A use call-site closures → migrating to reload-survival later means
   changing every offline mutation call site (registration) — a second migration A's own users
   must schedule.
2. Apps written against A internalize await-the-create — client ids later change app id
   discipline and obsolete the rewrite machinery A shipped as its *primary* chain path (sunk
   complexity that must then be maintained as legacy).
3. If A's failure surface is promise-shaped, hazard #9/#11-class terminal failures after reload
   have nowhere to land, so A must ship most of R9 anyway — at which point B's remaining delta is
   the registry and the id mint.

Replicache's history is the empirical version of this argument: the registry, client ids, and
rebase were in the *first* shippable shape, because the team understood that a queue without
replay is not the product (e2 §1, §9-mechanisms #1/#2/#6). The one thing they added later — and
we should too — is everything in §4.2.

## 5. E5's catalog, R1–R11

- **R1 Durability** — AC1.1/1.2: the §2.1 store + write-behind discipline; every status
  transition persisted; `completed`-ungated entries rebuild-and-gate (§2.1 step 5), never resend
  as new work (dedup absorbs even a duplicate, AC1.2). AC1.3: `navigator.storage.persist()`
  requested; eviction survival documented as not promisable. AC1.4: `OutboxStorage` seam,
  memory default = today's semantics.
- **R2 Exactly-once effect** — AC2.1: replay ack with original commitTs (§2.4). AC2.2: guard
  inside the store transaction on both docstores — Postgres shipped
  (`postgres-docstore.ts:89-94`), SQLite hook added (the priced gap,
  `sqlite-docstore.ts:159,174`). AC2.3: per-seq records + deterministic re-routing (§2.4 —
  the tension resolved, trade disclosed). AC2.4: guard at the owning shard's commit point
  (`node.ts:916` precedent). AC2.5: ack-prune + 30-day TTL + orphan sweep; per-seq rows are
  O(live queue) per client, not O(history) — the head-to-head verdict the spec mandated: the
  identity-keyed ordered family wins on identity/ordering/lifetime/resume-token (e1 §2.2's four
  of six), and B keeps its per-seq variant precisely to also keep sharding (the axis Lunora
  never faces because the DO *is* the shard).
- **R3 Ordering** — client-enforced FIFO during drain (head-of-line, one unacked head);
  AC3.2's invariant holds because a stale retry finds its record (exact-match) and a reordered
  *new* send cannot exist (the client doesn't pipeline the drain). AC3.3: mid-drain disconnect
  resumes at the handshake — 1..3 dedup'd by records, 4..7 drain.
- **R4 Chains** — resolution (i) client-supplied ids as primary (§2.2, costs assessed), plus
  (ii) rewrite as fallback (§2.3, AC4.3(ii) honored). AC4.2: chains survive reload because the
  seed persists and ids re-derive deterministically from it.
- **R5 Poison** — skip-and-record in the same record family as success (AC5.1); explicit
  classification (AC5.2); terminal failures fire from durable records on resume — no living
  promise required (AC5.3); a wedge cannot survive restart because the skip is server-side
  durable (AC5.4).
- **R6 Resume** — the handshake is the correctness half (watermark echo, seq reseed, consumed-
  entry settlement); O(ack) subscription resume is the deferred optimization and AC6.3 is met by
  construction (every R1–R5 path works with full resubscribe). AC6.2: the S4 session rules are
  *kept*, and the gate is unchanged — §2.1 step 5 is the proof sketch, with the fleet-lag case
  covered by the existing G4 frontier, not a new invariant.
- **R7 Multi-tab** — Web Locks leader + server-dedup-as-safety (AC7.1); shared IndexedDB +
  BroadcastChannel for AC7.2; AC7.3 scoped out explicitly with the layers-are-per-tab
  justification (and the registry as the future unlock).
- **R8 Conflict UX** — intent replay under OCC; the taxonomy (succeeds / self-no-ops /
  permanently rejects → R5) documented (AC8.1); failed intents carry `(udfPath, args,
  enqueuedAt, error)` through R9 (AC8.2); stale-optimism window documented + type-widening
  recipe (AC8.3); queue age/size advisory before the Safari cliff (AC8.4, hazard #2).
- **R9 Observability** — in-slice, not deferred (§4.1): accessors over the durable store, so
  they answer for entries whose promises died with the old page — Firestore's #3661 gap and
  Lunora's settled-event answer (e4 §1.6) taken as the bar. AC9.4: Zero's two-promise shape
  evaluated and **rejected** for v1 — our ack already carries commitTs and the layer-drop gate
  gives "saving…"/"saved" from one promise + accessors; a second promise per mutation is API
  surface without new information in our model.
- **R10 Performance** — enqueue stays sync (AC10.1, §2.1); the drain benchmark (500 mutations,
  time-to-empty, longest main-thread block) lands in the benchmark record; drain paces under the
  backpressure caps (AC10.3 — `MutationResponse` is already undroppable,
  `handler.ts:162-170`); dedup check is a PK point lookup (AC10.4).
- **R11 Uniqueness** — B is the only position that makes the flagship claim *whole*: durable
  offline **with reload-surviving optimistic UI and offline chains** + exactly-once effects +
  server-authoritative reactive queries + deploy-anywhere + write-sharded. A's version of AC11.2
  passes the drain and fails the user (§1's scenario is a live demo any reviewer can run).
  Neighbors' conceded legs per e5's grid; Lunora tracked as pacing competitor — CF-locked,
  and its watermark serializes the online path, which B specifically does not.

## 6. E4's environmental-hazards checklist, 1–16

1. **Whole-origin eviction** — queue + cache die together; server records make a partially-
   replayed-then-evicted queue safe (replays dedup; unreplayed intents are lost *with* their
   optimistic display, so no ghost UI); `persist()` requested; documented.
2. **Safari 7-day wipe** — contract explicitly time-bounded; 30-day server retention ≥ the
   client ceiling; age advisory (R8.4) fires well before.
3. **`persist()` denied silently** — treated as advisory; zero behavior change on denial.
4. **`QuotaExceededError` mid-append** — persistence failure surfaces via `onPersistenceError`-
   style callback + warn (Lunora's swallowed-but-reported pattern,
   `.reference/lunora/client/src/offline-queue.ts:86-103`); the mutation itself is not failed;
   the entry is marked non-durable (it will not survive reload, honestly).
5. **Private mode / no IndexedDB** — adapter probe → in-memory fallback with the same API
   (`.reference/lunora/client/src/persistence.ts:180-194` shape).
6. **Two tabs, one queue** — leader lock is optimization; correctness = server records (§2.1).
7. **Tab killed mid-drain** — sent-unacked entries re-classify at the next handshake (record
   hit → consumed; miss → resend); FIFO resumes from the durable store; the (clientId, seq)
   identity survives with the record.
8. **Reload resets counters** — seq reseeds from the handshake echo; a stale seq resend is
   answered `applied: false` + original commitTs, never silently swallowed (the Lunora
   `applied:false` reissue lesson, `.reference/lunora/lunora-client.ts:887-903`, made
   unnecessary by exact-match records: our replay ack *is* the truthful verdict).
9. **Auth change with queued writes** — identity stamped at enqueue, gated at flush, discarded
   **loudly** through the R9 surface on mismatch (`.reference/lunora/lunora-client.ts:4161-4179`
   policy); server-side, identity is in the record PK, so even a buggy client cannot replay
   across identities.
10. **Schema/app version change** — entries version-stamped; mismatch → drop-with-verdict
    through R9 (Lunora `persistenceVersion`, `offline-queue.ts:201-247`); additionally the
    server's argument/document validation (D5, shipped) terminal-fails stale-shaped args into
    the R5 path rather than committing garbage.
11. **Poison writes** — coded-verdict vs transient split + un-encodable-args triage at enqueue
    (terminal immediately, `.reference/lunora/lunora-client.ts:4224-4247` rule); skip-and-record
    server-side; FIFO never blocks (R5).
12. **Queue overflow** — bounded (default 1000), oldest-evict with observable
    `OFFLINE_QUEUE_OVERFLOW`-class settlement even for awaiter-less hydrated records
    (`offline-queue.ts:169-187` shape).
13. **`navigator.onLine` lies** — never gated on it; drain = always-attempt on reconnect/first
    frame + interval nudge (`.reference/lunora/db/src/internals.ts:235-272`).
14. **No Background Sync off Chromium** — portable contract is drain-on-next-visit + nudge; SW
    drain is a named follow-on and requires the queue format + auth to be SW-readable (noted in
    the storage-seam design).
15. **Server timeline resets** — the durable client record carries the deployment stamp; a
    handshake against a different deployment (or a `ConnectAck` that disowns the clientId)
    surfaces the Replicache terminal state: disable-and-notify, abandon the queue observably
    (`.reference/mono/packages/replicache/src/persist/client-groups.ts:231-250` — "an explicit
    terminal state" is mechanism #10, not an oversight).
16. **Ack vs sync-stream gap** — the convergent invariant all three systems reached (Lunora
    `lastMutationId` gate, Linear `lastSyncId`, our ts-gate): the layer drops when the *synced
    view* covers the write. B keeps it with the unchanged `versionCoversCommit` — including for
    handshake-acked entries, which is the case A-without-rebase cannot even express (no layer
    exists to hold; §2.1 step 5).

And E2's ten Replicache-school mechanisms as a checklist: B ships all ten (intent storage #1;
dense per-client seq #2; dedup atomic with commit #3 — per-seq records rather than one integer,
the sharding-shaped variant; skip-≤ #4 via exact-match, gap handling client-side; ack through
durable records + handshake, not the push RPC alone #5; rebase over the fresh head #6; poison
with teeth #7; multi-writer safety by idempotence #8; lifecycle GC both sides #9; explicit
terminal state #10). Position A, by its own scope, concedes #1's second half (intent without
replayability), #6, and the client half of #5 — which is the difference this paper argues.

## 7. The Zero objection, answered rather than dodged

The strongest critique of any offline-writes position is E2's strategic datum: the team with the
most production browser-outbox experience kept the machinery and turned offline writes **off**
(`mutator-proxy.ts:84-121`, verified; "Zero is not designed for long periods offline"). Three
answers, none of them hand-waves:

1. **Their reversal is a default-policy call, not an architecture verdict** — Zero still embeds
   the full Replicache DAG/rebase/recovery stack (e2 §8). What they rejected is *silent* queuing
   whose failures arrive as hours-later broken promises to code that has moved on.
2. **B removes the specific thing Zero could not tolerate.** Their v1 failure surface was
   promise-shaped; ours is durable and subscribable (R9 in-slice), failures are skip-and-
   recorded (never wedge, never vanish), the queue has age advisories before the platform
   cliffs, and the taxonomy is documented (R8). An hours-later rejection lands in a durable
   inbox the app renders, not a rejected promise nobody holds.
3. **The dial belongs to the developer, and the default is Zero's.** No `OutboxStorage`
   adapter → exactly today's fail-fast behavior (typed `MutationUndeliveredError`, nothing
   queued across sessions). The meta-decision E2 demands every design state out loud is stated:
   *offline writes are bounded, observable promises — days not weeks, surfaced not silent,
   opt-in not ambient.*

## 8. Confidence and open questions

High confidence: every shipped-tree claim above was read from source this session (S1–S4 seams,
kernel insert path, id-codec, commit-guard plumbing including the SQLite gap, protocol/handler,
verdict/spec bindings). Verified in the clones: Replicache's registry-stub and rebase invariants,
Zero's offline rejection. Carried from the evidence corpus with its citations: Lunora line-level
claims (e4, clone at `2e8df7b`), PowerSync loop mechanics (e3), browser-platform behavior (e4
Part 2, URLs there).

Open questions the spec owes: (1) exact deterministic derivation for client-minted internal-id
bytes (hash construction from `seed.entropy` — must be specified, tested for distribution, and
frozen); (2) whether the not-exists check on insert-with-id needs an index touch beyond the pk
`get` under the pending-write overlay (read `packages/transactor/src/uncommitted-writes.ts`
before assuming); (3) the `ConnectAck` cross-ring point-lookup batch's latency under the 8-shard
default (measure; if it matters, the records can be dual-written to a client-home ring as a
non-authoritative cache — authority stays with the commit-ring row); (4) IndexedDB write-behind
flush ordering under rapid enqueue (batch appends per microtask vs per entry — measure against
AC10.1's budget); (5) whether `skipped` records for *drain-path* failures should also be written
for **online** (non-drain) permanent failures for surface uniformity, or whether online keeps
today's immediate-reject (proposed: keep today's — no record, the promise is alive and the
answer is authoritative — but say so in the spec).
