# Position A — The Lunora-Shaped Minimum

Position agent A in the durable-offline-outbox adversarial workflow. This paper argues the
**minimal-but-complete** design: persist S1's `PendingMutation` intents to a pluggable durable
store (IndexedDB in browsers, Web Locks single-drainer); replace random in-memory `requestId`s
with a durable **per-tab `clientId` + monotone `clientSeq`**; add ONE per-client watermark row
server-side, written **atomically with the mutation's commit** through the already-shipped
commit-guard channel (B3's machinery generalized into free-tier core); FIFO drain with
`seq ≤ watermark` acked-without-rerun; **no client-supplied ids** in v1 (create-then-edit awaits
the create — a documented boundary, not a gap); poison = pause-the-queue + a durable app
callback. Every E5 requirement is either met with a testable AC or bounded out loud.

Code claims cite `file:line` on this branch; reference-clone claims cite
`.reference/<repo>/<path>:<line>` (studied, never copied). Line numbers for `.reference/lunora`
are valid at `2e8df7b`, `.reference/mono` as read 2025-11-04 (per E2/E4). Uncertainty is flagged
inline. Evidence base: [e1](e1-our-foundations.md), [e2](e2-replicache-zero-source.md),
[e3](e3-electric-powersync-source.md), [e4](e4-lunora-and-browser-realities.md),
[e5](e5-requirements-bar.md).

---

## 0. Thesis: the watermark is the whole design, and we already own every part but one

Three facts, all source-verified, make the minimum the strongest position:

1. **The field converged on one server primitive.** Replicache's entire exactly-once story is
   one transactional integer per client — "the effects of a mutation … and the corresponding
   update to the lastMutationID must be revealed atomically"
   (`.reference/mono/packages/replicache-doc/docs/reference/server-push.md`; live SQL: a
   `DO UPDATE SET "lastMutationID" = current + 1` inside the same SERIALIZABLE transaction as the
   effects, `.reference/mono/packages/zero-cache/src/services/mutagen/mutagen.ts:447-453`).
   Lunora shipped the same shape as `__client_watermark (identity, client_id, last_mutation_id)`
   with the advance running *inside the mutation's transaction*, strict-mode failure rolling the
   whole mutation back (`.reference/lunora/shard-do.ts:3535-3556`, `:3549-3552`;
   `.reference/lunora/ctx-db-client-watermark.ts:53-58`). Linear's `lastSyncId`, Zero's LMID —
   four independent production systems, one integer. A design that ships *more* than this needs
   to explain what the extra machinery buys; a design that ships *less* (random keys) answers
   zero of the six gaps E1's distance table names (identity, ordering, lifetime, reach, path,
   license — e1 §2.2).

2. **Our transactor hands us the atomicity for free — through a channel that already exists and
   is already exercised.** `RunOptions.commitMeta` flows from `runtime.run`
   (`packages/runtime-embedded/src/runtime.ts:789-812`) through the transactor
   (`packages/transactor/src/types.ts:103`) into `DocStore.commitWrite(entries, indexWrites,
   shardId, { meta })` on both the single-commit and the B4 group-commit path
   (`packages/transactor/src/shard-writer.ts:371`, `:548`). The per-unit commit-guard contract —
   `CommitGuardUnit { ts, meta }`, "the guard runs ONCE per commitWriteBatch transaction …
   e.g. an idempotency-row INSERT at each unit's own ts" — lives in **core, free-tier
   `packages/docstore`** (`packages/docstore/src/types.ts:86-96`), not in `ee/`. B3 proved the
   whole chain end-to-end: guard INSERT atomic with the commit and the frontier bump
   (`ee/packages/fleet/src/node.ts:911-973`, atomic write at `:964-971`), the
   `replayed`/`commitTs`/`valueMissing` response shape
   (`packages/cli/src/http-handler.ts:92-104`), and the loser-aborts-then-reads-winner pattern
   for the concurrent-duplicate race (`http-handler.ts:73-90`, `:238-240`). Lunora needed three
   self-healing layers because DO SQLite auto-commits per statement outside the wrapped path
   (`.reference/lunora/shard-do.ts:3566-3576`, `:3471-3492`); we need exactly one layer, plus
   B3's post-run value cache. E4's takeaway verbatim: "our transactor gives us layer 1 for free"
   (e4 §1.4).

3. **The client half was built for this.** S1's `PendingMutation` carries the serializable
   triple + seed and keeps `requestId` "opaque … so a future durable outbox can choose uuid vs
   monotone clientSeq without reshaping this record"
   (`packages/client/src/mutation-log.ts:14-33`, `:15-16`, seed at `:26`). S4's inflight-reject
   is explicitly conditioned on the outbox's absence — "retry is unsafe — there is no
   server-side dedup **yet**" (`packages/client/src/delivery-policy.ts:19-20`, also `:10-11`) —
   with the swap points named: `closeDisposition` (`delivery-policy.ts:40-59`) and
   `Reconciler.closeSession` (`packages/client/src/reconcile.ts:184`). The reconnect flush
   already resends `unsent` entries FIFO with original ids
   (`packages/client/src/client.ts:335-342`).

The one part we do NOT own: the SQLite docstore has **no commit-guard seam** — E1 flagged this
as an open unknown; I read the code and it resolves precisely. `commitMeta` reaches
`SqliteDocStore.commitWrite` but is discarded: "SQLite has no commit guard to hand it to, so it
is ignored" (`packages/docstore-sqlite/src/sqlite-docstore.ts:159-165`, batch path `:169-174`);
only `PostgresDocStore` has `setCommitGuard`
(`packages/docstore-postgres/src/postgres-docstore.ts:93-96`, invoked inside the commit
transaction at `:303`). **The single genuinely new engine seam this slice needs is a symmetric
`setCommitGuard` on the SQLite docstore**, invoked inside its synchronous commit transaction.
The contract already exists in core types; the Postgres side already implements it; the guard
implementation (a watermark upsert) is ~a table and an UPSERT per store. That is the entire
server bill beyond wiring — and it is priced below (§7), not hand-waved.

The strategic frame: Zero's team — who built Replicache's full offline machinery — turned
offline writes OFF rather than ship unvalidated promises
(`.reference/mono/packages/zero-client/src/client/mutator-proxy.ts:84-121`;
https://zero.rocicorp.dev/docs/offline). E5 §0.2 draws the right conclusion: the bar is the
**bounded intent-outbox done completely**, not indefinite-offline multi-master. The minimum is
not the timid position — it is the position that takes Zero's warning seriously and ships only
promises we can keep. Every mechanism beyond the watermark that a rival proposes (client-minted
ids, cross-reload optimistic layers, session resume, batch pipelining across rings) is a place
where THIS slice can die; each is severable, and severing them is the design.

---

## 1. The design on one page

**Client.** `MutationLog` (S1) gains a pluggable `OutboxStore` seam: `memory` (default —
today's exact semantics, zero behavior change) and `indexeddb` (browsers). Each client instance
(≈ tab session) mints a durable `clientId` (`crypto.randomUUID()`), persisted in the same
IndexedDB database as the queue; `requestId` becomes `"<clientSeq>"` where `clientSeq` is a
monotone integer persisted per entry — the opaque-string contract of `mutation-log.ts:15-16`
means nothing reshapes. Persisted record: `{clientId, clientSeq, udfPath, args, seed,
identityFingerprint, outboxVersion, enqueuedAt, status}`. Insertion order becomes an explicit
persisted key (E1 §1.1's warning: Map order does not survive serialization). On reload, a
**new** clientId is minted for new work; hydrated entries drain under their **recorded**
clientId+seq (the Replicache multi-tab move: any pusher can push any client's mutations because
the server watermark makes duplicates no-ops,
`.reference/mono/packages/zero-client/src/client/mutation-tracker.ts:341-346`).

**Drain.** FIFO, one unacked head at a time (no pipelining in v1), triggered by transport
reopen (`client.ts:335`), by enqueue-while-connected, and by an interval nudge — never gated on
`navigator.onLine` (Lunora observed it stuck under Playwright/Firefox,
`.reference/lunora/db/src/internals.ts:235-272`). Exactly one tab drains: Web Lock
`stackbase:outbox:<db>` held-for-lifetime (the Lunora/PowerSync pattern,
`.reference/lunora/lunora-client.ts:2688-2734`,
`.reference/powersync-js/.../WebStreamingSyncImplementation.ts:26-31`) — with the server
watermark as the correctness backstop when locks are unavailable or misfire ("locks are an
optimization, never the safety", e4 §1.6).

**Server.** One new internal table in each docstore, `client_watermarks (identity, client_id,
last_seq, last_commit_ts, last_value_json?, updated_at)` — keyed by *authenticated* identity
because clientId is client-supplied (Lunora's forgery rationale,
`.reference/lunora/ctx-db-client-watermark.ts:6-12`). The sync handler classifies BEFORE the
handler runs, Lunora's three-way (`.reference/lunora/shard-do.ts:3394-3468`):

- `seq ≤ watermark` → **ack without re-running**: `MutationResponse {success: true, replayed:
  true, ts: last_commit_ts, value | valueMissing}` — the recorded result where cached, B3's
  worked answer where not (`http-handler.ts:92-104`).
- `seq == watermark + 1` → run, threading `commitMeta = {identity, clientId, seq}`; the
  **watermark commit guard** advances the row inside the same store transaction as the
  effects. A conditional advance (abort if `last_seq != seq - 1`) makes the guard the
  enforcement and classification a mere fast path — the concurrent-duplicate loser aborts,
  re-reads, and replay-acks, exactly B3's 23505 pattern (`http-handler.ts:73-90`).
- `seq > watermark + 1` → reject `OUT_OF_ORDER` with `expectedSeq` — a safety net the FIFO
  client never trips, and the property AC3.2 demands.

A frame with no `clientId` runs unconditionally, exactly today's path — the legacy fallback
Lunora also keeps (`.reference/lunora/shard-do.ts:1918-1919`). Failed executions never advance
the watermark; the next entry reclaims `watermark + 1`
(`.reference/lunora/db/src/define-mutators.ts:101-103`) — so the dedup table records only
successes, and poison handling needs no server-side skip machinery at all (§5.2).

**Scope boundaries, stated as product contract:** mutations only (queued offline actions are
unvalidated side effects — out, permanently, per the isolation invariant); no client-supplied
ids (create-then-edit awaits the create, §5.1); no optimistic layer crosses a reload (intents
survive; rendering is same-session — §2.3); durability is "reload/crash, best-effort
eviction, ≤7 days on Safari" (§9, hazards 1–2); resume/`Connect` stays the reserved no-op seam
(§5.3).

---

## 2. Client architecture, precisely

### 2.1 What persists where

| Datum | Where | Why |
|---|---|---|
| Intent triple `(udfPath, args)` + `seed` | `OutboxStore` (IndexedDB store `outbox`, autoincrement PK = replay order) | The triple is already wire-shape JSON (`mutation-log.ts:19-20`, args converted at `client.ts:170`); the seed MUST persist or placeholder ids change identity across reload (`mutation-log.ts:26`; e1 §1.1) |
| `clientId`, per-entry `clientSeq` | Same IndexedDB database | Co-location is load-bearing: whole-origin eviction takes queue AND identity together, so a stale clientId can never resend against a fresh queue or vice versa (hazard 1, §9) |
| `identityFingerprint` (auth identity at enqueue) | Per entry | Stamped at enqueue, gated at flush, discarded loudly on mismatch (`.reference/lunora/lunora-client.ts:4161-4179`; hazard 9) |
| `outboxVersion` (app/schema stamp) | Per entry | Drop-with-verdict on mismatch at hydrate (Lunora `persistenceVersion`, `.reference/lunora/offline-queue.ts:201-247`; hazard 10) |
| `status` (`unsent` / `parked` / `failed{error, at}`) | Per entry | `parked` is new: sent-but-unacked at session death — safe to resend BECAUSE the watermark exists. `failed` outlives the promise (R9) |
| NOT persisted: `update` closure, `touched`, layers, `observedTs` | — | `touched` reconstructs free (`packages/client/src/layered-store.ts:152`); layers never cross a session (§2.3); the ts-gate resets per session by design (`delivery-policy.ts:2-7`) |

`mutation()`'s synchronous initiation path stays synchronous (AC10.1): optimistic apply +
listeners fire immediately; the IndexedDB append is async write-behind with a documented
single-digit-millisecond crash window — versus Replicache's ~1s idle-scheduled persist
(`.reference/mono/packages/replicache/src/replicache-impl.ts:144-148`), ours is strictly
smaller because each entry writes eagerly, and an entry is never *resent from durable state* it
never reached. `QuotaExceededError` on append is a persistence failure surfaced via
`onPersistenceError`, never a mutation failure (Lunora's swallowed-but-reported pattern,
`.reference/lunora/offline-queue.ts:86-103`; hazard 4). No IndexedDB (Node/Bun/private mode) →
the probe falls back to `memory` with the same API contract
(`.reference/lunora/persistence.ts:180-194` shape; hazard 5) — and the client keeps ZERO new
hard dependencies, preserving E1 §5's isomorphism (the seam mirrors `DatabaseAdapter`/
`BlobStore` discipline).

### 2.2 The drain loop

Single-drainer (Web Lock leader) hydrates persisted entries at startup, then on every wake:

1. **Identity gate** per entry against the current session identity; mismatch → terminal
   `OFFLINE_IDENTITY_CHANGED`, fired through `onMutationFailed` — discard loudly, never replay
   under the wrong user (`.reference/lunora/lunora-client.ts:4161-4179`, `:4103-4118`).
2. **Encodability/version triage**: un-encodable args or version mismatch → terminal now, not
   re-queued forever (`.reference/lunora/lunora-client.ts:4224-4247`).
3. Send head with its recorded `(clientId, seq)`; await ack. Success → un-persist, resolve
   promise if alive, else fire the settled observer (`hadAwaiter: false` — Lunora's post-reload
   observability move, `.reference/lunora/offline-queue.ts:16-23`).
4. Coded server verdict (mutation ran and failed / OUT_OF_ORDER impossible under FIFO) →
   §5.2's poison path. Codeless error (transport) → stop the pass, requeue in order, backoff
   (`.reference/lunora/lunora-client.ts:4296-4311`).

Head-of-line one-RTT-per-mutation is the watermark's known cost (e4 §1.5). Two mitigations,
one free: (a) mutations that commit are acked at commit speed — the transactor's B4 group
commit batches concurrent units already; (b) a `MutationBatch` frame (client sends a seq-ordered
window, server applies sequentially in one pass, per-unit watermark advances riding
`commitWriteBatch`'s per-unit meta, `packages/docstore/src/types.ts:79-84`) is designed-in and
scheduled honestly: in-slice if the R10 benchmark demands it, fast-follow otherwise (§7). Lunora
ships exactly this shape (`/_lunora/rpc-batch`, sequential chunks,
`.reference/lunora/lunora-client.ts:4187-4217`).

### 2.3 Multi-tab, and the layer rule that keeps the design sound

Each tab = one clientId (Replicache's model: tab = client, random id,
`.reference/mono/packages/replicache/src/persist/make-client-id.ts:7-10`). Live tabs send their
own mutations directly — no cross-tab seq coordination exists to get wrong (E4 hazard: shared
clientId + per-tab counters = OUT_OF_ORDER storms, e4 §2.3). The leader additionally drains
*persisted* entries from dead sessions under their recorded ids; if a not-actually-dead tab
also resends, the watermark makes the duplicate a replay-ack. Election failure is never a
correctness event.

**No optimistic layer crosses a reload — and I defend this as correctness, not laziness.** E1
§1.3 already warns the ts-gate is only sound over one monotone feed (`delivery-policy.ts:2-7`).
The sharper reason: a fresh session's resubscribe baseline arrives with the fresh session's
version (`packages/sync/src/handler.ts:244-267`; adopted at `client.ts:249-254`), and a
**replay-ack for an already-committed entry generates no new commit, hence no fan-out, hence no
Transition that ever raises the fresh session's `version.ts` past the original commitTs** — a
rebuilt layer for such an entry double-renders on top of its own echo with no sound drop
trigger (the G4 class, e3 §4.7). So: hydrated entries drain as plain mutations (no layer);
same-session entries keep today's full Gated Ledger behavior unchanged. Cross-reload optimistic
rendering is a follow-on gated on the lmid-shape gate revisit the verdict already scheduled
(`docs/dev/research/client-sync/verdict.md:154`). What the user experiences after reload:
pending writes listed in `usePendingMutations` (R9) with "syncing" status, effects appearing
through the reactive feed as the drain commits — honest, visible, correct. Note this makes the
registry-by-`udfPath` (verdict.md:152) **optional DX in v1** rather than load-bearing: it ships
as an API, but nothing breaks when an updater is unregistered.

---

## 3. The server contract — where designs die, and why this one doesn't

### 3.1 Storage

`client_watermarks` is an internal engine table in BOTH docstores (same category as
`persistence_globals`, `packages/docstore-sqlite/src/sqlite-docstore.ts:6`; physically-schemaless
internal tables on Postgres). One row per (identity, clientId): `last_seq`, `last_commit_ts`,
`last_value_json` (64KB cap, B3's `lease.ts:77-82` precedent), `updated_at`. **O(1) per client**
— this is R2.5/AC10.4 answered by data-structure choice, where a random-key table answers it
with a TTL sweep that silently re-executes anything older than the window
(`ee/packages/fleet/src/lease.ts:84-87` documents exactly that boundary at 1h). Retention: rows
idle > 30 days GC'd by a core reaper driver (the `storageReaper` recurring-driver seam) —
sized to dominate the client's real durability window (Safari's 7-day cap, §9.2), and
documented as the server half of the time-bounded contract.

### 3.2 Atomicity — the exact mechanism, on both docstores

The watermark guard is a **core** implementation of the existing `CommitGuardUnit` contract
(`packages/docstore/src/types.ts:86-96`): for each unit whose meta carries `{identity,
clientId, seq}`, execute inside the store's commit transaction:

- Postgres: an UPSERT with a conditional guard (`WHERE client_watermarks.last_seq = seq - 1`,
  insert path requires `seq = 1`); zero rows affected → raise → the whole commit aborts →
  the caller re-reads the row and replay-acks (B3's loser-reads-winner,
  `http-handler.ts:73-90`, `:238-240`). Installed via the shipped `setCommitGuard`
  (`postgres-docstore.ts:93-96`, invoked at `:303`).
- SQLite: the **new symmetric seam** — `setCommitGuard` invoked inside the synchronous commit
  transaction where meta is currently ignored (`sqlite-docstore.ts:159-165`). Same conditional
  UPSERT, same abort semantics. This is the slice's one new engine seam; it is small (the
  transaction boundary and the meta are already at the call site) and it is exactly the
  symmetry the storage-pluggability locked decision demands.

Because advance-or-abort runs INSIDE the commit, the three properties every rival must also
prove come for free:

- **No ack-before-commit window** (AC2.2): the ack is sent after `runMutation` returns with a
  real commitTs (`handler.ts:281-287`) — effects and watermark share the commit.
- **Shared fate under disaster** (hazard 15): a PITR/restore rolls effects AND watermark back
  together; the client's resend re-executes against the restored world — which is the *correct*
  outcome, since the effects were rolled back too. Dedup state that lives outside the store
  (Redis, a sidecar) cannot make this claim.
- **Guard-as-enforcement**: pre-run classification is a latency optimization; the conditional
  advance is the invariant. Two concurrent sends of the same seq (leader + not-dead tab) both
  classify `next`; one commits, the loser's entire transaction aborts and replay-acks. No
  window exists. (The abort must be typed so the transactor's OCC-replay loop doesn't retry
  it — the same narrow-shape discipline B3 used for 23505; named as implementation risk,
  not hand-waved.)

One composition detail priced honestly: `setCommitGuard` holds a single guard today
(`postgres-docstore.ts:75-96`), and fleet B3 installs its own at boot (`node.ts:916`). The
slice generalizes this to a guard chain (or one dispatcher keyed by meta fields) — an additive
change to both docstores, exercised by the fleet E2E that already exists.

### 3.3 Shards and fleet — resolving E5's named tension (AC2.3, AC2.4)

E5 R2 names the real tension: a global per-client watermark row seems to re-serialize one
client through one ring, undoing B2a. The minimum dissolves it with two observations:

1. **The watermark row is not an app document.** It is internal store state written by the
   guard inside whichever shard's commit transaction carries the client's mutation — it does
   not live in a ring, is not routed by `shardBy`, and imposes no one-doc-one-ring constraint.
2. **The FIFO client makes per-client row contention structurally absent.** One unacked head
   at a time ⇒ a given (identity, clientId) never has two mutations in commit concurrently
   ⇒ the row never sees concurrent writers, whichever rings successive mutations land on.
   Cross-*client* throughput is untouched — different clients' rows are different rows. The
   serialization cost is exactly the per-client FIFO the ordering requirement (R3) demands
   anyway; we pay for it once, at the drain, not twice. (The `MutationBatch` follow-on keeps
   this: sequential application within the batch, per-unit guard advances in ts order.)
   Lunora never faces the question because the DO is the shard (e5 R2); we face it and answer
   it with the same per-client serialization Lunora's push chain imposes client-side
   (`.reference/lunora/db/src/define-mutators.ts:96-103`).

Fleet (AC2.4): the guard lives at the **owning shard's commit point**, so a resend forwarded
via `/_fleet/run` to a different node still hits the same store transaction domain — the same
argument B3's forward-retry dedup already proves end-to-end (`node.ts:964-971`;
`http-handler.ts:217-229` shows commitMeta threading on that path today). The sync handler
gains the same threading: `executor.runMutation` grows an optional commitMeta/dedup parameter
(additive signature change at `handler.ts:275-280`). The replay-ack's `ts` echo composes with
the shipped G4 fleet fallback (`handler.ts:288-294`) unchanged, because replays carry the
original (or newer, §3.4) commitTs.

### 3.4 The replay-ack's `ts`, and why the Gated Ledger needs zero changes

`versionCoversCommit` (`packages/client/src/reconcile.ts:25-27`) stays byte-identical — the
strongest minimalism claim in this paper. A replay-ack echoes `last_commit_ts`. For the FIFO
client the resent entry IS the head, so `last_commit_ts` is its own original commitTs (with
`last_value_json` its recorded result). In the degenerate cases (value oversized; crash between
commit and the post-run value UPDATE — B3's documented `valueMissing` window,
`lease.ts:89-99`), the ack carries `valueMissing: true` and the promise resolves `undefined`,
documented. If a stale sub-head resend ever appears (leader + live tab race), echoing
`last_commit_ts ≥ originalCommitTs` is a *conservative* gate bound — store-allocated timestamps
are globally monotone (B1: store-allocated ts, epoch-fenced), so waiting for a later ts still
strictly covers the write. The gate predicate, the Transition payload, S3's isolation — all
untouched.

---

## 4. Wire protocol changes — additive by construction

`parseClientMessage` is a bare `JSON.parse` with a versioned-by-shape contract
(`packages/sync/src/protocol.ts:73-75`, `:7-9`), so every change below is optional-field
additive; old clients ride the legacy unconditional path.

| Message | Change |
|---|---|
| `Mutation` (`protocol.ts:46`) | + `clientId?: string`, `clientSeq?: number`. Both present → dedup path; absent → today's behavior, bit-for-bit |
| `MutationResponse` success (`protocol.ts:57-66`) | + `replayed?: true`, `valueMissing?: true`; `ts` already carries commitTs with its send-site invariant (`handler.ts:286`) |
| `MutationResponse` failure | + `code?: string` (`"OUT_OF_ORDER"` with `expectedSeq?: number`; general coded-verdict channel for §5.2's terminal/transient split — today's `error` string stays for compatibility) |
| `Connect` (`protocol.ts:44`) | **Untouched** — remains the reserved no-op seam (`handler.ts:197-198`) for the resume follow-on |
| Follow-on | `MutationBatch` / batched responses (§2.2) — new message types, additive |

No session identity moves to the wire beyond `clientId` — identity scoping happens server-side
from the authenticated session (`SetAuth`), never from a client-supplied field
(`.reference/lunora/ctx-db-client-watermark.ts:6-12`).

---

## 5. The three hard questions

### 5.1 Dependency chains (R4): no client-supplied ids, and why that is the strong call

The documented v1 boundary: **an offline `create` resolves its promise only at drain-commit, so
a dependent edit is never mintable while offline.** What offline users CAN do, today, with zero
new machinery: edit any existing doc; queue arbitrarily many independent writes; and — the
underrated one — perform create-plus-dependent-edits **as one mutation**, because our unit of
intent is a transactional server function, not a row op. `createProjectWithTasks(args)` needs
no id round-trip at all; the mutation IS the chain. Schools that queue row diffs (PowerSync)
need client ids *structurally*; a school-C intent queue needs them only for **cross-mutation**
chains authored as separate calls.

Why not ship client ids anyway, as school C urges by fiat (e3 §1.3)? Because for US the fiat is
a second engine slice wearing the first one's badge: the id-codec and both docstores must
accept client-minted ids with format/collision/forgery validation (AC4.3), and — uniquely to
us, no school-C member write-shards — client-minted ids must compose with `shardBy` routing and
the one-doc-one-ring invariant. Bundling that into the outbox doubles the blast radius of the
slice's final whole-branch review, the exact composed-path failure mode this project's history
warns about repeatedly (write-sharding memory: every slice's final review caught composed-path
blockers). The alternative resolution — placeholder-arg rewrite — was PowerSync×Convex's
self-declared #1 DX cost (e3 §2.4) and dies on AC4.2's reload requirement without re-persisted
rewrites. The seam stays open: args are opaque JSON; a later client-id scheme changes the
id-codec and validators, not one line of the outbox. AC4.1/4.2 are met in v1 for
single-mutation chains and honestly marked N/A for cross-mutation chains, with the boundary in
the product docs.

### 5.2 Poison (R5): pause-and-ask, because dependents are unvalidated promises

Classification is deterministic for us in a way it is not for PowerSync: a `MutationResponse
{success: false}` means the handler ran and the transaction aborted — **zero effects persisted**
(the transactional property; re-running a failed mutation is harmless, which is why at-least-once
delivery of *failures* needs no dedup row at all). Codeless/transport errors are transient →
backoff + retry. Coded verdicts are terminal. On a terminal verdict at the head:

1. Mark the entry `failed{error, at}` **durably** — the record outlives the promise (AC5.3).
2. Fire `onMutationFailed` (refires from the durable record on next hydrate if unhandled —
   no silent vanishing, ever; the Redux-Offline ghost and Firestore's unobservable queue are
   the named anti-patterns, e4 §3.2, e5 R5).
3. **Pause the drain** with the failed entry parked at the head, surfaced in
   `usePendingMutations` as `blocked`. The app resolves: `entry.skip()` (drop it, continue —
   the seq is reclaimed by the next entry, since failures never advanced the watermark,
   `.reference/lunora/db/src/define-mutators.ts:101-103`), `entry.retry()`, or
   `queue.discardFailed()`. A `poisonPolicy: "pause" | "skip"` client option makes
   auto-skip one word for independent-writes apps.

Why pause is the right *default*, argued head-on against school C's skip-and-bump: Replicache
auto-skips because its rebase re-renders the world after the skip and its docs push conflict
pain to app-level undo (`.reference/mono/.../offline.md`); Zero auto-skips into a **journaled
error result** delivered to the app (`mutagen.ts:196-262`) — and then turned offline writes off
entirely, because hours-later rejections are unresolvable UX (e2 §8). Our queued entries after
a failed head may be *logically* premised on it (same doc, same workflow) even with no id
dependence; auto-executing them against a world where the premise failed is exactly the
"unvalidated promises" Zero refused to ship. Pause converts an undecidable inference (are
m3..mN independent of m2?) into an explicit app decision, costs nothing on the no-failure path,
and cannot wedge silently: the pause is durable state + a refiring callback + visible
accessors, satisfying AC5.4's "no silent wedge across restarts" — progress resumes on one
API call. PowerSync's four sanctioned strategies (e2 §2.3) show "block" is a legitimate point
on this axis; ours is block-with-a-loud-durable-doorbell, one line from skip. AC5.1's letter
(m3 auto-commits past a failed m2) is met under `poisonPolicy: "skip"` and deliberately
diverged from under the default, with this paragraph as the argued justification.

Note what the watermark bought here: **no server-side skip machinery exists at all.** No
error-mode re-run, no skip-recorded-in-dedup-family — a failed mutation never consumed its seq.
The entire poison policy is client-side state over R9 accessors. That is the minimum earning
its name.

### 5.3 Resume (R6): deferred, and the deferral is load-bearing

Reconnect remains full-resubscribe (`handler.ts:244-267`) — priced "fine at today's scale" by
the verdict (verdict.md:155). AC6.3 makes resume an optimization that R1–R5 must not depend on;
this design passes that test *constructively*: the drain needs only `MutationResponse` acks
(exempt from backpressure dropping, `handler.ts:162-170`), not any resumed subscription state.
The `Connect` no-op (`handler.ts:197-198`) stays reserved; the watermark itself becomes the
natural resume token for the follow-on (a `Connect {clientId}` reply echoing `last_seq` +
`last_commit_ts` gives the client its server-confirmed frontier in one frame — the lmid-shape
identity confirmation verdict.md:154 schedules). Bundling resume now would put the
one-monotone-feed invariant (S4's soundness condition) in play in the same slice that touches
delivery semantics — two invariant-bearing changes, one review. No.

AC10.3's reconnect-storm composition is still owed in-slice: the drain paces itself under the
undroppable-frame caps alongside full resubscribe — the E2E includes drain + resubscribe on one
connection.

---

## 6. Migration from today's S1–S4 — what changes, what is additive

| Shipped seam | Change | Nature |
|---|---|---|
| S1 `MutationLog` (`mutation-log.ts:36-59`) | Backed by `OutboxStore` seam; persisted seq column replaces Map-order reliance; status alphabet + `parked`/`failed` (the union was designed additive, `mutation-log.ts:29-32`) | Additive; `memory` default = today, bit-for-bit |
| `requestId` mint (`client.ts:48`, `:168`) | Counter → persisted `clientSeq`; `clientId` alongside. Record shape unchanged (opaque string honored, `mutation-log.ts:15-16`) | Swap at one mint site |
| S4 `closeDisposition` (`delivery-policy.ts:40-59`) | `inflight` → `parked` (retain + resend) instead of reject+drop — **only when the entry carries clientId/seq**; the file's own comments say this is the designed swap (`delivery-policy.ts:10-11`, `:19-20`). Consumers: `reconcile.ts:184`, `client.ts` reject loop | The designed swap, at the named sites |
| S4's no-layer-crosses-session rule (`delivery-policy.ts:2-7`) | **NOT relaxed** — strengthened into the hydrate rule (§2.3) | Unchanged invariant |
| S3 `versionCoversCommit` (`reconcile.ts:25-27`) | **Untouched** (§3.4) | Zero change |
| Reconnect flush (`client.ts:335-342`) | Same loop, now draining `unsent` + `parked` under the drainer lock | Extension |
| Wire (`protocol.ts:44-66`) | §4's optional fields | Additive |
| `handleMutation` (`handler.ts:269-301`) | Classify → thread commitMeta → replay-ack path; legacy path preserved verbatim for id-less frames | Additive branch |
| Docstores | Postgres: guard-chain generalization of `setCommitGuard` (`postgres-docstore.ts:75-96`); SQLite: the new guard seam (`sqlite-docstore.ts:159-165`); both: `client_watermarks` table + reaper | The one new engine surface, priced in §7 |
| `executor.runMutation` (`handler.ts:275`) | Optional dedup/commitMeta parameter | Additive signature |

Nothing in the optimistic-updates slice is reshaped; the spec's outbox-alignment promise
(`docs/superpowers/specs/2025-10-16-optimistic-updates-design.md:113-126`) is discharged seam
by seam, and E5's cross-cutting check #4 (each requirement lands on a named shipped seam, or
the new seam is priced) is answered by this table.

## 7. One slice vs follow-ons

**The slice** (each item E2E'd through the real `stackbase dev`/`serve` server, both docstores
where the commit path is touched, shards + fleet where delivery is touched — E5's cross-cutting
discipline):

1. `OutboxStore` seam + IndexedDB adapter + memory fallback; clientId/clientSeq; persisted
   entries with identity/version stamps; write-behind with stated crash window.
2. `client_watermarks` on both docstores; the SQLite `setCommitGuard` seam; guard chaining;
   the core watermark guard (conditional advance, abort-and-replay); post-run value cache;
   30-day reaper.
3. Sync-handler classification + commitMeta threading + replay-ack (`replayed`/`ts`/
   `valueMissing`/`OUT_OF_ORDER`); same for `/api/run`; fleet-forward threading verified.
4. S4 park-and-resend swap; Web Locks single-drainer; hydrate rules (no cross-reload layers);
   drain loop with identity gate, triage, coded/codeless split, backoff, interval nudge.
5. Poison pause + `skip()/retry()/discardFailed()` + `poisonPolicy` option.
6. R9 surface: `client.pendingMutations()`, `usePendingMutations()`, `onMutationFailed` with
   durable refire — the verdict's deferred bill (verdict.md:79,153), due now because promises
   die on reload.
7. The flagship E2E pair (AC11.2): same app, offline-queue → reload → reconnect →
   exactly-once drain on (a) single-binary SQLite and (b) Postgres + fleet + shards. Plus the
   R10 benchmark (500-mutation drain; enqueue-latency delta; frame-budget check) into the
   benchmark record.

**Fast-follows, severable by design:** `MutationBatch` drain (unless the benchmark forces it
in-slice); registry-by-`udfPath` cross-reload optimistic layers (gated on the verdict.md:154
gate revisit); `Connect` resume with the watermark as token; client-supplied ids (R4 full —
its own spec, id-codec + shards); Background Sync SW drain (Chromium-only enhancement,
e4 §2.4); `navigator.storage.persist()` advisory API + queue-age warnings (AC8.4 ships as a
simple accessor in-slice; the proactive-estimate advisory can follow).

## 8. E5's catalog, answered item by item

- **R1 Durability** — AC1.1/1.2: met (persisted intents + seed; `parked` resends safely under
  the watermark; statuses hydrate correctly). AC1.3: met as bounded honesty — `persist()`
  requested, eviction documented as best-effort, never marketed. AC1.4: met (`OutboxStore`
  seam; memory default preserves today's semantics for Node/Bun).
- **R2 Exactly-once effect** — AC2.1: met (kill-after-commit E2E; resend replay-acks with
  original commitTs). AC2.2: met on BOTH docstores via the guard-in-commit (§3.2) — the SQLite
  seam is the priced new work. AC2.3: met by dissolution (§3.3: internal row + FIFO ⇒ no
  cross-ring coupling, no concurrent row writers). AC2.4: met at the owning shard's commit
  point, B3-proven channel. AC2.5: met by construction — O(1) watermark row vs a growing
  random-key table; the head-to-head the spec mandated (spec:124-125) resolves for the
  watermark on all six of E1's gap axes.
- **R3 Ordering** — AC3.1: met (FIFO drain, per-client commitTs monotone). AC3.2: met twice —
  client never pipelines past an unacked head AND the server rejects gaps + the guard aborts
  non-successor advances. AC3.3: met (mid-drain disconnect E2E; 1..3 replay-ack, 4..7 apply).
- **R4 Chains** — bounded: single-mutation chains fully supported (the mutation is the
  transaction); cross-mutation offline chains excluded in v1, documented, seam open (§5.1).
- **R5 Poison** — AC5.2/5.3/5.4: met (deterministic coded/codeless split; durable failed
  records + refiring callback; durable pause ≠ silent wedge). AC5.1: met under
  `poisonPolicy:"skip"`; default diverges deliberately, argued in §5.2.
- **R6 Resume** — deferred with the seam named and AC6.3 satisfied constructively (§5.3);
  AC10.3's storm test still runs in-slice.
- **R7 Multi-tab** — AC7.1: met (Web Locks leader, takeover-on-close E2E'd via lock release;
  correctness backstop is the watermark, per e4 §2.3's "any design only correct when election
  works is wrong"). AC7.2: met (shared IndexedDB queue; leader drains dead tabs' entries under
  recorded ids). AC7.3: scoped out explicitly as permitted — layers stay per-tab; shared state
  is intent + status only.
- **R8 Conflict UX** — AC8.1: met (the taxonomy is exactly ours: succeed / no-op by mutation
  logic / terminal → R5; no merge, no CRDT — e4 §3.3's settled fork). AC8.2: met via R9
  payloads (udfPath, args, enqueuedAt, server error). AC8.3: met — frozen-base speculation
  bounded by §2.3's no-cross-reload-layers rule, which also caps the staleness window at one
  session. AC8.4: queue-age/size accessors in-slice; proactive advisory follow-on.
- **R9 Observability** — met in full, in-slice (§7 item 6); Zero's two-promise DX evaluated:
  rejected for v1 — `status` on the durable record plus `onMutationFailed` covers the "saving…"
  state without a second promise that dies on reload anyway (the durable record is strictly
  more truthful than any promise).
- **R10 Performance** — AC10.1: met (sync initiation preserved; write-behind measured).
  AC10.2: benchmarked; `MutationBatch` is the pre-designed lever if 500-drain misses budget.
  AC10.3: in-slice E2E. AC10.4: O(1) row read + conditional UPSERT.
- **R11 Uniqueness** — the claim survives with qualifiers (AC11.1): durable bounded-offline
  intents + exactly-once effects + server-authoritative reactive queries + deploy-anywhere +
  write-sharded. AC11.2's flagship pair is §7 item 7 — the one test no neighbor can run
  (Lunora CF-locked, Zero no offline writes, Electric no write path, PowerSync replica-bound,
  Convex in-memory-only; e5 R11 grid). Lunora tracked as pacing competitor per AC11.3.

## 9. E4's sixteen hazards, item by item

1. **Whole-origin eviction** — queue + clientId co-evict (co-located, §2.1): no orphaned
   identity, no stale-seq resend. Lost entries are lost *loudly next visit* only if the app
   checks — honest limit: an evicted queue is unreported (nothing survives to report from);
   documented, and `persist()` requested to shrink the class. Server safety: a
   partially-drained-then-evicted queue is safe — drained seqs are watermarked, undrained ones
   simply never arrive. Invariant: both halves.
2. **Safari 7-day wipe** — contract states "survives reloads/crashes; not weeks of absence on
   Safari" (e4 §2.2); the 30-day server watermark window comfortably outlives any queue that
   can still exist client-side. Age accessor lets apps warn before the cliff. Client + docs.
3. **`persist()` silently denied** — requested, treated as advisory, zero behavior branches on
   the grant (§2.1). Client.
4. **`QuotaExceededError` mid-append** — persistence failure ≠ mutation failure;
   `onPersistenceError` + the entry stays in-memory-live for this session (Lunora's pattern,
   `.reference/lunora/offline-queue.ts:86-103`). Client.
5. **Private mode / no IDB** — probe → memory fallback, same API (`.reference/lunora/persistence.ts:180-194` shape). Client.
6. **Two tabs, one queue** — leader drains; watermark makes double-drain a replay-ack;
   correct with locks absent (§2.3). Server is the safety, per the checklist's own required
   answer. Both.
7. **Killed mid-drain** — sent-unacked = `parked`, resend-safe by watermark; next
   leader resumes FIFO from durable state (requeue never un-persisted,
   `.reference/lunora/offline-queue.ts:279-292` discipline). Both.
8. **Reload resets counters** — dissolved structurally: a reload mints a NEW clientId; old
   entries drain under their recorded (clientId, seq). No reseed-from-echo protocol exists to
   get wrong (vs Lunora's `applied:false` reissue loop,
   `.reference/lunora/lunora-client.ts:887-903` — machinery we simply don't need). Client.
9. **Auth change with queued writes** — identity stamped at enqueue, gated at flush, terminal
   `OFFLINE_IDENTITY_CHANGED` + callback (loud); server watermark is identity-keyed so even a
   client bug cannot cross users (`.reference/lunora/ctx-db-client-watermark.ts:6-12`). Both.
10. **Schema/version change** — `outboxVersion` stamp; mismatch at hydrate → drop with verdict
    through `onMutationFailed`. Client (+ the additive-schema deploy gate bounds server drift).
11. **Poison writes** — §5.2: terminal-immediately for coded verdicts and un-encodable args;
    durable pause + doorbell; never infinite retry (the codeless path has backoff and the head
    is retried, not the FIFO abandoned). Both.
12. **Queue overflow** — bounded (default 1000); overflow **rejects the new enqueue** with a
    coded error + observer — an immediate honest failure to the user present at the keyboard,
    rather than silently un-persisting the oldest durable promise (deliberate divergence from
    Lunora's evict-oldest, `.reference/lunora/offline-queue.ts:169-187`, argued: the new write
    has a live awaiter to reject; the old one may not). Client.
13. **`navigator.onLine` lies** — never consulted; drain wakes on transport reopen (real
    backoff lives in `packages/client/src/transport.ts:71-75`) + interval nudge
    (`.reference/lunora/db/src/internals.ts:235-272` precedent). Client.
14. **No Background Sync off Chromium** — portable baseline is drain-on-next-visit +
    reconnect wake; SW drain is a named follow-on, never the durability story (e4 §2.4). Client.
15. **Server timeline resets** — watermark and effects share the store, hence share fate
    through PITR/restore: resends re-execute against the restored world, which is correct
    (§3.2). Deployment-id stamping (fleet hardening) covers the fresh-DB case; the client
    persists no cross-session ts to confuse. Server.
16. **Ack vs sync-stream gap** — unchanged Gated Ledger: layers drop on
    `versionCoversCommit`, replay-acks echo a covering commitTs (§3.4), G4's origin-frontier
    machinery (`handler.ts:288-294`) applies to fresh commits; hydrated entries carry no layer
    so the no-fan-out replay case cannot flash (§2.3). Both.

## 10. Where the rivals will attack, and the standing answers

- *"No client ids = no offline create-then-edit = not Convex-grade DX."* The chain-as-one-
  mutation pattern covers the majority case better than row-op systems can (§5.1); the
  remainder is a documented boundary with an open seam, not a closed door. The rival must
  price id-codec forgery rules + shard routing of client ids **in the same slice** — and
  defend that composed risk against this project's own review history.
- *"Pause-on-poison fails AC5.1's letter."* Under the default, yes — argued as the correct
  divergence (§5.2), with `"skip"` one word away. The rival defaulting to skip must explain
  executing possibly-premised writes against a falsified world, to the team whose reference
  point (Zero) refused offline writes over exactly that.
- *"Per-tab clientId litters watermark rows."* O(1) each, 30-day reaped, and it deletes the
  entire reseed/reissue protocol class (hazard 8) — rows are cheaper than protocol.
- *"FIFO drain is slow."* One-RTT-per-mutation is the measured cost of total per-client order
  (e4 §1.5); the benchmark decides, and `MutationBatch` (Lunora-proven shape) is pre-designed
  to ride B4 group commit without touching any invariant.
- The honest residual weaknesses, owned: enqueue durability has a small write-behind crash
  window (stated, measured); cross-reload pending writes render as status, not as optimistic
  data (§2.3 — correctness over spectacle until the gate revisit); the SQLite guard seam is
  new engine surface and gets the full both-docstores conformance treatment; eviction loss is
  unreportable (hazard 1) — no design in the field does better, and the ones that claim to
  (Replicache's recovery sweeps) still lose queues past their GC cliffs
  (`.reference/mono/packages/replicache/src/persist/client-gc.ts:18`).

The minimum's closing argument: every load-bearing mechanism in this design is either already
shipped in our tree (commitMeta channel, guard contract, S1 triple, S4 swap points, ts-gate),
already production-proven in a system we read at source level (watermark atomic with effects,
three-way classify, identity gating, Web Locks leader), or both. The slice's only new engine
seam is symmetric with one that exists. Everything a rival adds beyond this must clear a bar
none of them has yet stated: name the shipped seam it lands on, or price the new one.
