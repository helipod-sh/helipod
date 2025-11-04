# Position C — The Split: the watermark server contract exactly, the registry for reload-survival, and the id question deferred by irreversibility

Position agent C in the durable-offline-outbox adversarial workflow. Evidence base: E1–E5 in
this directory, plus direct reads of our tree (branch `scheduler-component`, 2025-11-04) and the
`.reference/` clones cited by the evidence agents. Code claims carry `file:line`; reference-clone
claims cite `.reference/<repo>/<path>:<line>`; uncertainty is flagged inline. No reference code
is copied — studied and described only.

## 0. The position in one paragraph

Ship, in one slice, the two things that are **irreversible or that unblock everything else**:
(1) the full per-client watermark server contract — `(identity, clientId)` + monotone
`clientSeq`, three-way classification before the handler, the watermark row committed
**atomically with the mutation's effects in core** (both docstores, free tier, through shards
and the fleet forward path), skip-and-bump poison semantics, and the `Connect` handshake that
reseeds the client's sequence; and (2) the **registry-by-`udfPath`** — the one piece of client
convention without which durable persistence is a lie (a reloaded intent with no way to rebuild
its optimistic layer is Electric's Pattern-3 ghost: renders nothing, or renders forever —
`.reference/electric/examples/write-patterns/patterns/3-shared-persistent/index.tsx:166-172`,
E3 §2.2). **Defer client-supplied ids and arg-rewriting.** The cut line is not taste; it is
irreversibility: the watermark is a wire + storage contract we will live with forever and must
get perfect once; the registry is additive client convention with zero protocol surface; client
ids are a server-surface expansion (id-codec, insert validation, forgery rules, codegen types)
that can be **added later without changing one byte of the outbox protocol** — because in
school C's own design, ids travel *inside `args`* (`.reference/mono/packages/replicache-doc/docs`,
E2 §1.1: intent = name + args). Deferring it costs exactly one scenario (two *separate* queued
mutations where the second references the first's offline-created id), which has an idiomatic
workaround (composite intents, §5) and the weakest demand evidence on the menu (§5.2).

## 1. The cut line, argued by irreversibility

Rank every candidate mechanism by what it would cost to change after shipping:

| Mechanism | Surface it commits | Reversible later? |
|---|---|---|
| `clientId + clientSeq` on the wire; watermark storage + classification semantics | Wire protocol (every client ever built), dedup-table schema, the meaning of "replay" | **No.** Convex-parity clients, the fleet forward path, and every persisted outbox in the field will depend on these exact semantics. Replicache's `lastMutationID` contract has been frozen since v1 for this reason (E2 §3). |
| Dedup atomic-with-commit in core (guard seam on both docstores) | `DocStore` interface, transactor commit path | **No.** A v1 that ships non-atomic dedup ("insert the row after the commit") bakes in Lunora's layer-2/layer-3 repair machinery forever (`.reference/lunora/...shard-do.ts:3471-3492`, E4 §1.4) — they needed three layers because DO SQLite auto-commits; we get layer 1 free and must take it now. |
| Skip-and-bump poison rule recorded in the watermark row family | The semantics of a failed seq — visible to every future client | **No.** Changing "does a terminal failure advance the watermark" after v1 changes replay behavior for persisted queues in the field. |
| S4 park-and-resend swap | Client close-disposition policy | Cheap either way — but it is *gated on* the watermark existing (`packages/client/src/delivery-policy.ts:10-11,19-20` conditions the fail-fast on "no server dedup exists", twice). |
| Registry-by-`udfPath` | Client API convention only | Fully additive (`docs/dev/research/client-sync/verdict.md:152` names it as the receiving seam). But **without it, R1's durability is display-broken on day one** — so it ships now despite being reversible. |
| Durable-storage seam + IndexedDB adapter | Client package, new dependency-free seam | Additive; adapter set grows by demand (the `DatabaseAdapter`/`BlobStore` discipline, CLAUDE.md). |
| **Client-supplied ids** | id-codec, docstore insert path, document validation (`Id<"table">` typing), forgery/cross-tenant rules, codegen, dashboard | **Yes — cleanly.** Ids-as-args means the outbox never sees them; adding acceptance of client-minted ids later is an id-codec feature with its own spec, and no queued-entry format, wire field, or watermark semantic changes. |
| **Placeholder-arg rewriting** | Outbox drain atomicity, a new crash-window family (AC4.3ii) | Rejected outright, not deferred — PowerSync×Convex's self-declared #1 DX cost (E5 R4, E3 context), and it violates the verdict's no-placeholders-in-args bar (verdict.md:140; spec:158-159). |

Everything above the line ships in the slice. Client ids are the only *demanded-by-a-catalog-row*
item below it, and §5 prices that deferral honestly.

## 2. The server contract, precisely (where designs die)

### 2.1 Wire changes — all additive by construction

`parseClientMessage` is a bare `JSON.parse` (`packages/sync/src/protocol.ts:73-75`; the protocol
doc declares versioned-by-shape extensibility, `protocol.ts:7-9`), so every field below is
backward-compatible:

- **`Mutation` gains `clientId?: string` and `clientSeq?: number`** (today's shape:
  `{requestId, udfPath, args}` only, `protocol.ts:46`). Both absent → the legacy path: run
  unconditionally, exactly today's `handleMutation` (`packages/sync/src/handler.ts:269-301`).
  This mirrors Lunora's header-absent fallback (`.reference/lunora/...shard-do.ts:1918-1919`)
  and means old clients, tests, and the dashboard function-runner change nothing.
- **`requestId` stays what it is** — the per-session correlation echo (`handler.ts:283,299`).
  We do NOT overload it as the durable identity, despite `mutation-log.ts:15-16` reserving that
  option: the durable identity is the explicit `(clientId, clientSeq)` pair, because responses
  are correlated per-connection by `requestId` today and a resend on a new session keeps its
  original `requestId` (`packages/client/src/client.ts:326-343`) — two orthogonal jobs, two
  fields. The opaque-string promise is honored by *not needing* to reshape the record: the
  persisted entry stores both.
- **`MutationResponse` (success) gains `replayed?: true` and `valueMissing?: true`** — the B3
  worked answer for "duplicate whose value you no longer have"
  (`packages/cli/src/http-handler.ts:92-104`). A replay ack carries the ORIGINAL `commitTs` in
  the existing `ts` field (`protocol.ts:57-66`), so the client's ts-gate
  (`packages/client/src/reconcile.ts:25-27`) works unchanged on a resend — AC2.1's exact
  requirement.
- **`MutationResponse` (failure) gains `code?: string`** — machine-readable verdicts:
  `"OUT_OF_ORDER"` (with `expectedSeq`, the Lunora echo that makes the client's resend
  algorithm trivial — `.reference/lunora/...shard-do.ts:3456-3468`), and the terminal verdict
  codes for R5. The coded-vs-codeless split becomes the retry policy (E4 §1.9(c)).
- **`Connect` is activated** (today a reserved no-op — `protocol.ts:44`, `handler.ts:197-198`,
  the seam the verdict reserved at §(g)): the client sends
  `{type: "Connect", sessionId, clientId?}`; a new additive `ConnectAck` server message returns
  `{clientId, watermark, watermarkCommitTs, known: boolean}`. The client gates its first drain
  on this echo — the reseed that closes hazard #8 (reload resets counters; Lunora's
  seed-from-watermark, `.reference/lunora/...define-mutators.ts:115-119`, and the zero-seq
  silent-swallow guard, `lunora-client.ts:887-903`). A future session-resume token is an
  additive field on this same message — the seam is used compatibly, not consumed.

### 2.2 Storage and atomicity: a core commit-guard seam, both docstores

**The E1 open unknown, resolved by code read.** The `commitMeta` channel is plumbed uniformly
through the transactor to `DocStore.commitWrite` on every path — single commit and B4 group
commit both pass `{ meta: commitMeta }` (`packages/transactor/src/shard-writer.ts:368-371`,
`:548`; threaded from `RunOptions` at `:323` and `:452`). The asymmetry is one level down: the
**SQLite docstore accepts `meta` and drops it** — "SQLite has no commit guard to hand it to"
(`packages/docstore-sqlite/src/sqlite-docstore.ts:159-165`, batch path `:174`) — while
`PostgresDocStore.setCommitGuard` takes a batch-shaped guard over `CommitGuardUnit[]`
(`packages/docstore-postgres/src/postgres-docstore.ts:76,93-94`; unit contract at
`packages/docstore/src/types.ts:69-93`: the guard runs once per `commitWriteBatch` transaction,
in unit/ts order, single-commit is a one-unit batch — exactly ONE guard contract). So the slice's
server work is precise and bounded: **promote `setCommitGuard` from a `PostgresDocStore` extra
to the `DocStore` interface** (optional method — additive; stores without it keep today's
behavior) and implement it on `SqliteDocStore`, where the commit is already one synchronous
SQLite transaction, making the guard INSERT/UPDATE trivially atomic. This is not new machinery —
it is finishing a seam B3 built and proved end-to-end on one store
(`ee/packages/fleet/src/node.ts:911-973`; guard INSERT inside the same transaction as commit +
frontier bump at `:964-971`).

**The table** (core, free tier — NOT `fleet_idempotency`, which fails all six outbox axes: random
unordered keys, no client identity, 1h TTL, Postgres+fleet-only with a silent no-op elsewhere
(`node.ts:962-963`), HTTP-only, and `ee/`-commercial — E1 §2.2's distance table; outbox dedup is
core reliability and single-node self-host is free forever, CLAUDE.md):

```
client_watermark(identity TEXT, client_id TEXT, last_seq INTEGER,
                 last_commit_ts, last_verdict, value_json?, updated_at,
                 PRIMARY KEY (identity, client_id))
```

Identity-scoped because `clientId` is client-supplied and unauthenticated — without identity in
the key one user could suppress another's sequence (Lunora's stated rationale,
`.reference/lunora/...ctx-db-client-watermark.ts:6-12`; DDL shape `:53-58`). `value_json` is the
best-effort replay-value cache: UPDATEd after the run, size-capped, `valueMissing` on the crash
window or oversize — the fleet's worked pattern (`ee/packages/fleet/src/lease.ts:77-99`). Note
the watermark makes retention **O(1) per client** (R2.5/AC10.4): only the latest row per
`(identity, clientId)` exists, vs. a random-key table growing per mutation — one of the four
axes on which E1 §6 already found the watermark family answers gaps random keys answer zero of.

**Classification, before the handler** (Lunora's three-way, adopted whole —
`.reference/lunora/...shard-do.ts:3394-3468`):

- `seq <= watermark` → **ack without re-running**: `{success: true, replayed: true, ts: last_commit_ts, value|valueMissing}`.
  If `last_verdict` for that seq was a terminal failure, echo the failure verdict instead —
  success and failure replays come from the same record family (AC5.1's composition).
- `seq == watermark + 1` → run the mutation; the commit guard writes the watermark advance in
  the same store transaction as the effects.
- `seq > watermark + 1` → reject `{code: "OUT_OF_ORDER", expectedSeq}`, never apply.

The atomicity claim is Replicache's contract verbatim ("revealed atomically … same transaction,"
`.reference/mono/packages/replicache-doc/docs/reference/server-push.md`, E2 §3) and Lunora's
layer-1 primary path (`shard-do.ts:3535-3556`, strict-mode rollback `:3549-3552`). Our transactor
gives us layer 1 free — the guard runs inside the store's commit transaction on both docstores —
so we need **one layer, not Lunora's three** (E4 §1.4's takeaway), plus the replay-value echo.

### 2.3 Shards: resolving R2.3, not hand-waving it

E5 names R2.3 the genuine tension: a global per-client watermark row vs. per-(client, ring)
records. The resolution rests on a fact of our shipped topology: **all shard rings commit into
ONE physical store** — `ShardedTransactor` holds a single `DocStore`
(`packages/transactor/src/sharded-transactor.ts:75`) and each ring's writer calls
`docStore.commitWrite(..., shardId, ...)` against it (`shard-writer.ts:371`). The watermark row
is **not a document** — it is commit-guard state like `fleet_idempotency`, outside MVCC, outside
the one-doc-one-ring invariant. So:

- **One global row per `(identity, clientId)`, written by whichever ring the mutation commits
  on.** Atomic by construction (same physical transaction), on both stores.
- **Why this does not re-serialize the client's writes through one ring**: the protocol already
  serializes each client — monotone `clientSeq` with gap rejection means at most one *new* seq
  is applicable at a time. The drain pipelines on one connection (§3.4), but the watermark check
  is an O(1) row read/write per commit, on the ring the data write was already routed to; no
  cross-ring commit, no ring pinning. Contention on the row exists only when a resend races a
  later send of the *same client* — the exact race the row's lock/upsert is there to serialize.
  Postgres per-ring commit connections take a row lock for the duration of one commit; SQLite is
  single-connection anyway. Cross-*client* throughput (what B2a bought) is untouched.
- **Per-(client, ring) records are rejected** on correctness grounds, not preference: with the
  drain's FIFO, m1 lands on ring A (watermark_A=1), m2 targets ring B — ring B's local watermark
  is 0, so `seq 2 > 0+1` misclassifies as a gap. Ring-local watermarks break the three-way
  classification unless they degrade to unordered per-seq dedup rows — which is the random-key
  family with all its costs.
- **Multi-node write distribution (B2b, unbuilt)** is the honest open edge: when rings live on
  different nodes, "one physical store" stops being true. The position's answer is the
  irreversibility discipline itself: the **wire contract does not change** — `(clientId,
  clientSeq, watermark echo, OUT_OF_ORDER)` is node-topology-agnostic; only the server-internal
  storage of the row moves (client-home placement, or a fenced shared table — B1's epoch fencing
  is the existing tool family). We are not deciding that now, and nothing in this design forces
  the decision early. Flagged, priced, deferred with the rest of B2b.

### 2.4 Fleet: the guard lives at the owning writer's commit point

AC2.4's requirement — a resend landing on a different receiving node must still dedup — is
satisfied by placement, the same placement B3 proved: forwarded writes execute at the writer
node, and the guard runs inside that node's commit transaction
(`ee/packages/fleet/src/node.ts:911-973`). A `Mutation` frame arriving at a follower's sync
handler forwards through the existing path; `commitMeta` rides `RunOptions` end-to-end
(`packages/cli/src/http-handler.ts:217-229` is the shipped precedent). The concurrent-duplicate
race (two nodes forwarding the same seq) resolves by the loser-reads-winner pattern
(`http-handler.ts:73-90`, re-SELECT at `:238-240`) — for the watermark, the loser's classify
re-reads and answers `replayed`. The flagship E2E (AC11.2) runs this exact composition.

### 2.5 Poison pills: skip-and-bump, recorded in the same row family

Adopt school C's rule with Zero's automation: a **deterministic app error** (validation, authz,
handler throw — the executor reports these distinctly from infra errors; the scheduler slice's
retryable-classification lesson applies) advances the watermark anyway, recording
`last_verdict = failed{code, message}` — Zero's "error mode" re-run that skips effects and bumps
LMID (`.reference/mono/packages/zero-cache/src/services/mutagen/mutagen.ts:196-262`; Replicache's
own docs use the word "deadlock" for the alternative, E2 §5). A **transient/infra error** does
not advance; the client retries with backoff (OCC conflicts never surface here — the transactor
replays deterministic UDFs internally, 3-phase OCC).

Mechanically, the failure advance is a commit whose write-set is empty but whose guard unit
carries the verdict — the guard channel already exists per-unit; **one check-before-build item
flagged honestly**: whether the transactor accepts a zero-document commit today or needs a small
affordance (a privileged internal advance path). Either way it is transactor-internal, not wire.

`Un-encodable args` terminal-fail at enqueue, client-side, before ever occupying a seq (Lunora's
poison-message rule, `.reference/lunora/...lunora-client.ts:4224-4247`) — hazard #11's second half.

### 2.6 Retention, GC, and the terminal state

- Watermark rows: swept after a configurable idle period, **default 45 days** — sized for
  "offline needs days" (E1 §2.2) and comfortably beyond Safari's 7-day storage cliff, vs. the
  fleet's 1h TTL sized for seconds-scale forward retries (`lease.ts:84-87`).
- `value_json`: cleared much earlier (hours) — it serves live-session resends; later replays get
  `valueMissing`, which is only consumed by promise-holders, and promises don't outlive reloads.
- **The terminal state** (Replicache mechanism #10, `client-groups.ts:231-250` precedent): a
  `Connect` where the client asserts a positive watermark but the server answers
  `known: false` means the server swept (or lost) this client's state. The client surfaces
  `onClientReset`, mints a fresh `clientId`, re-sequences **unsent** entries (never applied —
  safe), and **loudly rejects parked sent-but-unacked entries** (genuinely unknowable under a
  swept watermark — the same `MutationUndeliveredError` family, now correctly rare instead of
  every-disconnect). Infinite retry against a server that has forgotten you is the failure this
  closes.

## 3. The client architecture

### 3.1 What persists where

A new **`OutboxStorage` seam** in `packages/client` — the first persistence API the client has
ever had (verified: no storage API used anywhere today, E1 §5; deps are only sync+values,
`packages/client/package.json:33-36`) — following the project's adapter discipline
(`DatabaseAdapter`/`BlobStore`: the engine never imports a driver; CLAUDE.md). Ships with:
IndexedDB adapter (browsers; probe-and-fallback when open throws — private mode, hazard #5),
in-memory default (today's exact semantics — durability is opt-in configuration, AC1.4), and
the seam is where a Node/Bun fs adapter lands by demand.

The persisted record is S1's triple **plus everything E1 says must ride along**:

```
{ requestId, udfPath, args, seed,            // mutation-log.ts:14-33 — args already wire-JSON
  clientSeq?,                                 // assigned at first send, persisted BEFORE the wire (§3.4)
  status,                                     // richer alphabet: unsent | parked | draining | failed{code,error,at}
  identity,                                   // stamped at enqueue, gated at flush (hazard #9)
  enqueuedAt, order,                           // explicit seq column — Map insertion order does not
                                               // survive IDB (E1 §1.1's warning)
  schemaVersion }                              // version-stamp, drop-with-verdict on mismatch (hazard #10)
```

The **seed persists** (`mutation-log.ts:26`) — non-negotiable, or placeholder ids change identity
across reload and every temp-id swap breaks (E1 §1.1). `touched` does NOT persist — recomputed
free on every recompose (`packages/client/src/layered-store.ts:126-152`). `update` does NOT
persist — that is the registry's job (§3.2). The `clientId` and next-seq hint persist in the same
store, reseeded from `ConnectAck` (§2.1).

**Enqueue stays synchronous** (AC10.1): the optimistic apply and listener fire are unchanged
(`client.ts:161-195`); persistence is write-behind. The crash window is bounded and shrunk at the
boundary that matters: **durable-then-wire** — no entry transitions to the wire until its record
(with assigned seq) is awaited-durable. A lost never-sent entry is indistinguishable from
crashing a moment earlier; Replicache accepts a ~1s window for *all* mutations
(`.reference/mono/packages/replicache/src/replicache-impl.ts:144-148`, E2 §1.2) — we accept it
only for never-sent ones.

### 3.2 The registry-by-`udfPath` — B's piece, and why it is load-bearing

The `update` closure is "looked up at replay, never serialized" (`mutation-log.ts:23`) and today
there is no lookup — it is the caller's captured closure (`client.ts:175`). The verdict named the
receiving seam (verdict.md:152); it is new work, not a swap (E1 §1.1). The API is a client-level
registration map — `new StackbaseClient(url, { optimisticUpdates: { "messages:send": fn, ... } })`
(codegen can type the keys against the `api` object) — consulted at hydrate: a restored entry
whose `udfPath` is registered rebuilds its layer against the fresh session baseline via the
normal recompose path, with the persisted seed minting the SAME placeholder ids. An unregistered
entry hydrates **intent-only**: no layer, still drains, still correct — degraded to invisible
pending, never to a lost write.

Why this ships in the slice rather than by demand: without it, R1's flagship AC (enqueue offline
→ reload → commit **and render**) is only half-true, and the field's negative proof is exact —
Electric's Pattern 3 persists the overlay but nothing re-sends (E3 §2.2), the mirror-image
half-truth. Persistence without replay-capability is display continuity; replay without layer
rebuild is invisible pending. The registry is the ~50 lines that make the two halves one feature.
And it obeys the cut line: pure client convention, zero wire, zero server.

Inline closures keep working for online-session UX; their layers simply don't survive reload
(documented). S4's iron rule is untouched: **no layer of any kind crosses a session**
(`delivery-policy.ts:2-7`; `observedTs` reset at `reconcile.ts:189`) — what crosses is intent;
layers are always rebuilt against the new session's baseline.

### 3.3 The S4 swap: park-and-resend

`closeDisposition` (`delivery-policy.ts:40-59`) changes exactly as its own comments anticipate:
`inflight` → **`parked`** (layer still drops — the rule above — promise stays pending), resent on
the next session with original `(clientId, clientSeq)`; the watermark absorbs the duplicate and
the replay ack carries the original `commitTs`, so the rebuilt-or-absent layer and the ts-gate
compose unchanged. Consumption sites are the two E1 names: `reconcile.ts:183-192` and the client
reject loop (`client.ts:312-324`). Against a server that never answers `ConnectAck` (old server),
the client falls back to today's fail-fast policy wholesale — version-by-shape, no flag day.

### 3.4 The drain

- **Leader**: Web Locks (`navigator.locks`) single-drainer per origin+deployment; no-locks
  environments drain unconditionally (single-context). Correctness never rests on the lock —
  two drainers are wasteful, not wrong, because the watermark dedups (Lunora's stated rationale,
  `lunora-client.ts:2690-2692`; E4 §2.3's "any design only correct when leader election works is
  wrong"). No SharedWorker — that solves shared-SQLite-handle problems we don't have (E3 §4.5).
- **Seq assignment at first send, by the drainer, persisted before the frame goes out** (§3.1).
  This makes multi-tab seq minting single-context by construction (hazard: per-tab counters +
  shared clientId = OUT_OF_ORDER storms, E4 §2.3) and makes every resend byte-identical.
- **Pipelined window on one connection**: WebSocket frames are ordered per connection, so the
  drainer sends up to W (e.g. 32) sequential seqs without awaiting each ack — killing Lunora's
  one-RTT-per-mutation head-of-line cost (`define-mutators.ts:96-103`, E4 §1.5) while gap-reject
  remains the belt-and-braces (a server-side reorder or dropped frame produces `OUT_OF_ORDER`
  + `expectedSeq`, and the drainer rewinds — self-healing, no protocol ambiguity).
  *Check-before-build flag*: whether `handleMessage` processes a session's frames strictly
  serially today; the design is correct either way, but the window size tuning depends on it.
- **Wake conditions** (PowerSync's proven set, E3 §1.3): enqueue; transport reopen — drain runs
  AFTER `SetAuth` replay and `Connect`/`ConnectAck`, alongside resubscribe (the reopen sequence
  extends `client.ts:326-343`); an interval nudge that distrusts `navigator.onLine` (hazard #13;
  Lunora's always-true detector + 1s tick, `.reference/lunora/db/src/internals.ts:235-272`).
  Backpressure: the drain paces under the session cap (AC10.3) — `MutationResponse` is already
  exempt from dropping (`handler.ts:162-170`), the inbound direction is ours to throttle.
- **Retry policy**: coded error = server verdict = terminal (dequeue, record, surface); codeless
  = transport/transient = requeue in order with jittered backoff (the transport already has
  equal-jitter backoff, `packages/client/src/transport.ts:71-75`). Identity gate per entry
  against one snapshot; auth change discards LOUDLY, never replays under the wrong user
  (`lunora-client.ts:4161-4179, 4103-4118`; hazard #9).
- **Dequeue vs overlay-drop are different events**, kept separate on purpose: dequeue (delete
  the durable record) on the `MutationResponse` ack — safe because a lost ack just means one
  more resend absorbed by the watermark, closing the double-clear/strand hole Replicache closes
  by acking via pull (E2 mechanism #5, achieved by different means); overlay drop stays on the
  ts-gate (`versionCoversCommit`, `reconcile.ts:25-27`) — the three-system convergent invariant
  (Lunora `lastMutationId` gates, Linear `lastSyncId`, our ts-gate; E4 §1.5, §3.1, hazard #16).
  The G4 caveat E3 flags (a write invalidating nothing the client subscribes to never advances
  `version.ts`) is already half-solved on our tree — the origin-session frontier advances via
  fan-out or the fleet `pendingFrontiers` fallback (`handler.ts:288-294`); the drain gate rides
  the same mechanism since the drainer IS the origin session.

### 3.5 Observability (R9's bill, due now)

`client.pendingMutations()` + reactive `usePendingMutations()` read the durable store (shared
across tabs, BroadcastChannel change-nudge — advisory only); `onMutationFailed` fires from the
durable record on resume, so a terminal failure whose promise died with the old page is still
observed (Lunora's `MutationSettledEvent` with `hadAwaiter`, `offline-queue.ts:16-23`; the
direct answer to Firestore's #3661 gap, E4 §3.2). Failed entries persist in `failed` status
until dismissed or retried by app code — a failed offline write never silently vanishes (AC5.3,
AC9.3). Queue-age/size advisory before the Safari cliff (AC8.4, hazard #2).

## 4. Migration from today's S1–S4 — what changes, what is additive

| Piece | Kind |
|---|---|
| Wire: `clientId`/`clientSeq` on `Mutation`; `replayed`/`valueMissing`/`code` on `MutationResponse`; `ConnectAck` | Additive (bare-JSON parse, `protocol.ts:73-75`; absent fields = legacy path) |
| `DocStore.setCommitGuard` promoted to the interface; SQLite implementation | Additive interface method; Postgres already has it (`postgres-docstore.ts:93`) |
| `client_watermark` table + classification in the sync handler | New, core, free-tier; legacy frames bypass it entirely |
| `OutboxStorage` seam + adapters; persisted-record shape | Additive; memory default = today's behavior byte-for-byte |
| Registry-by-`udfPath` client option | Additive convention |
| R9 accessors | Additive (designed-for since S1, verdict.md:153) |
| **S4 `closeDisposition`: `inflight` → `parked`** | The one behavior change — and only when the server acked watermark capability; old-server fallback = today's policy |
| Status union grows (`parked`/`draining`/`failed`) | Additive to the enum (`mutation-log.ts:29-32` anticipated exactly this) |
| Unchanged invariants | No layer crosses a session; ts-gate predicate and its two call sites; seed-stable placeholders; FIFO = insertion order (now an explicit persisted column); `requestId` semantics |

## 5. The deferral, defended (R4: client-supplied ids)

**5.1 What is actually lost.** Exactly one scenario: two *separate* queued mutations where the
second's args reference the first's offline-created id. Everything else works in v1: offline
edits/deletes of pre-existing docs (full support), offline creates (queued, committed on drain,
optimistic layer renders via seed-stable placeholders), and — the idiomatic escape —
**composite intents**: because the queued unit is a named mutation (intent = code, school C's
foundational move, E2 mechanism #1), "create a thread and add its first message" is ONE mutation
with both effects, no id crossing the wire at all. Convex's own DX — our reference surface —
mints ids server-side and has apps await creates; we are not below the reference bar, we are at
it, plus a durable queue.

**5.2 Why the evidence ranks it last.** The verdict deferred it to "where it is load-bearing"
(verdict.md:156) — this slice makes it load-bearing *only for the chain scenario*. The field's
signal is mixed at best: school C solves it by fiat because their clients own a local store
where client ids are structural (Replicache/Zero, E2 §1.1/E5 R4 grid); PowerSync×Convex tried
the rewrite alternative and named it their #1 DX cost; and Zero — the team with the most
production outbox experience — ships no offline writes at all (E2 §8), so "users demand offline
create-then-edit chains" is the *least*-evidenced demand in the entire catalog. Meanwhile the
blast radius is the largest: the id-codec, the docstore insert path, runtime document validation
(`Id<"table">` is now enforced — the runtime-validation slice), forgery/cross-tenant rules
(AC4.3i's own list), codegen, and the dashboard. That is a full slice with its own spec and its
own security review, riding as a passenger on a protocol slice — precisely the shape the verdict
refused once already ("correctly refused as a rider," verdict.md:152).

**5.3 Why deferring is safe (the irreversibility test, applied).** Ids-as-args means the outbox
protocol, the persisted record, and the watermark are all id-scheme-agnostic. When the follow-on
ships, an offline create simply *includes its client-minted id in `args`* — no wire field, no
record migration, no watermark change, no drain change. AC4.2's killer (chains must survive
reload, which kills in-memory id maps) is answered by never building an id map at all. The
deferral costs a documented v1 limitation; shipping it now costs slice focus on the two
irreversible contracts. Arg-rewriting is rejected permanently, not deferred (§1's table).

## 6. One slice vs. follow-ons

**The slice** (one coherent, E2E-provable unit): wire fields + `ConnectAck` handshake ·
`client_watermark` + three-way classification · guard seam on BOTH docstores, atomic with
commit · skip-and-bump poison with verdict replay · watermark GC + terminal `onClientReset` ·
`OutboxStorage` seam + IndexedDB adapter + memory default · durable S1 record (seed, identity,
version stamps) · registry-by-`udfPath` · S4 park-and-resend swap · Web Locks drainer with
pipelined window + coded/codeless retry split + identity gating · R9 accessors + failure
surfacing · R10 benchmarks (enqueue p50; 500-mutation drain; backpressure composition) ·
the flagship E2E: same app, offline-queue → reload → reconnect → exactly-once drain, through
`stackbase dev`/`serve` on (a) single-binary SQLite and (b) Postgres + fleet + shards, plus the
kill-after-commit-before-ack resend (AC2.1) and the mid-drain-leader-kill takeover (AC7.1).

**Follow-ons, by demand, in order of likely pull**: (1) client-supplied ids (R4 chains — first
in line, its own spec); (2) session-resume token on `Connect` (R6's O(ack) resubscribe — an
optimization by its own AC6.3, never a correctness dependency; today's full-resubscribe cost is
"fine at today's scale," verdict.md:155); (3) Background Sync SW drain (Chromium-only
progressive enhancement — the portable baseline is drain-on-next-visit, E4 §2.4); (4) cross-tab
optimistic render as a tested AC (it already *falls out* for registered udfPaths — each tab
rebuilds layers from the shared store through its own registry — but v1 scopes it out of the
test matrix, AC7.3's sanctioned exit, because per-tab layer semantics deserve their own
scrutiny); (5) Node/Bun fs storage adapter.

## 7. E5's catalog, answered row by row

- **R1 Durability**: AC1.1 ✓ (flagship E2E); AC1.2 ✓ (`parked` survives; acked entries dequeued
  at ack — a crash between ack and dequeue re-sends once and the watermark absorbs it); AC1.3 ✓
  honesty clause verbatim — `persist()` requested, eviction not marketed; AC1.4 ✓ (seam,
  memory default). Grid row: school C's durability with school B's explicit-queue observability.
- **R2 Delivery**: AC2.1 ✓ (replay ack, original commitTs); AC2.2 ✓ **both docstores, atomic** —
  the guard-seam promotion, §2.2; AC2.3 ✓ resolved, not hand-waved — one store-level row, any
  ring, one physical store (§2.3); AC2.4 ✓ guard at the owning writer (§2.4); AC2.5 ✓ O(1)
  watermark vs. growing random-key table — the head-to-head the spec mandated
  (spec:124-125), decided for the watermark on all six E1 axes.
- **R3 Ordering**: AC3.1 ✓ (drainer FIFO by persisted order column); AC3.2 ✓ both mechanisms —
  pipelined-window client + server gap-reject (the AC said choose; we choose belt-and-braces
  because the reject costs one branch); AC3.3 ✓ (mid-drain disconnect → resend absorbed).
- **R4 Chains**: deferred — §5, priced: one scenario, composite-intent workaround, first
  follow-on. AC4.1 passes for composite intents; AC4.2/4.3 deferred with the feature.
- **R5 Poison**: AC5.1 ✓ (skip-and-bump in the same row family, §2.5); AC5.2 ✓ (coded/codeless +
  the executor's deterministic-vs-infra distinction); AC5.3 ✓ (`onMutationFailed` from the
  durable record, §3.5); AC5.4 ✓ (the skip is server-side and durable — a reload cannot un-skip).
- **R6 Resume**: split by the cut line — the watermark handshake (correctness: seq reseed,
  hazard #8) ships; the resubscribe-resume token (bandwidth optimization) defers. AC6.3 is the
  license: "resume is an optimization, never a correctness dependency; every AC in R1-R5 passes
  with resume disabled." AC6.2's re-derivation lands with the follow-on.
- **R7 Multi-tab**: AC7.1 ✓ (Web Locks, takeover proven in E2E); AC7.2 ✓ (shared durable store +
  accessors); AC7.3 scoped out with justification (§6.4) — the registry makes it reachable, the
  slice doesn't test it.
- **R8 Conflict UX**: AC8.1 ✓ taxonomy documented (succeed / no-op-by-own-logic / terminal → R5;
  mutation code IS the policy — intent replay, "strictly better than PUT/PATCH/DELETE," E5 R8);
  AC8.2 ✓ (failed intent + args + enqueue time + server error through R9); AC8.3 ✓ documented
  speculative-view bound + pending affordances; AC8.4 ✓ age/size advisory.
- **R9 Observability**: ✓ in full, §3.5 — the verdict's deferred bill (verdict.md:79,153) paid.
- **R10 Performance**: AC10.1 ✓ (sync enqueue, write-behind, durable-then-wire boundary);
  AC10.2 ✓ benchmark shape adopted, numbers to the benchmark record, pipelined window is the
  drain-throughput mechanism; AC10.3 ✓ paced under the backpressure cap; AC10.4 ✓ O(1) row.
- **R11 Uniqueness**: the combination claim survives this position *because* of the cut — the
  legs nobody else holds simultaneously (durable offline + exactly-once effects +
  server-authoritative reactive queries + deploy-anywhere + write-sharded) are all in the slice;
  client ids are a leg NO neighbor makes distinctive (school C has them as a store artifact, not
  a differentiator). AC11.2's pair-test (SQLite single binary AND Postgres+fleet+shards) is the
  flagship E2E. AC11.3: Lunora tracked as pacing competitor; our watermark is theirs minus the
  DO lock-in, plus two docstores and shards.

## 8. E4's hazards checklist, item by item

1. **Whole-origin eviction**: queue dies as a unit; the server watermark makes a
   partially-replayed-then-evicted queue safe (replays dedup; unsent entries are lost — and were
   never promised, AC1.3). User sees pending-count drop to zero + `onClientReset` if the
   watermark also aged out. Invariant lives: server.
2. **Safari 7-day wipe**: contract documented as time-bounded; watermark retention (45d) >>
   the cliff so a surviving queue never meets a swept watermark first; age advisory (AC8.4)
   warns before the cliff. Client + docs.
3. **`persist()` denied silently**: requested, treated as advisory, zero behavior change on
   denial. Client.
4. **`QuotaExceededError` mid-append**: persistence failure ≠ mutation failure — surfaced via
   `onPersistenceError`-style callback + warn (Lunora's pattern); the entry stays in-memory for
   this session. Client.
5. **Private mode / no IndexedDB**: adapter probe → in-memory fallback, same API contract
   (today's exact semantics). Client.
6. **Two tabs, one queue**: Web Locks leader; correct with zero coordination because the
   watermark dedups — locks are efficiency, the server is the safety (§3.4). Both.
7. **Tab killed mid-drain**: seq persisted before the wire (durable-then-wire); next leader
   resumes FIFO from the store; sent-but-unacked entries resend and dedup. Both.
8. **Reload resets counters**: `clientId` + next-seq persisted; `ConnectAck` reseeds
   (`max(persisted, server watermark)+1`); the zero/stale-seq silent-swallow is impossible
   because a stale seq answers `replayed` with the recorded verdict, not silence. Both.
9. **Auth change with queued writes**: identity stamped at enqueue, gated at flush, discarded
   loudly (`onMutationFailed` with an identity-changed code). Client, backstopped by the
   server's identity-scoped watermark key (a replay under the wrong identity misses the row
   entirely and cannot suppress the right user's sequence). Both.
10. **Schema/app version change**: records version-stamped; mismatch → drop with a terminal
    verdict through R9, never silent, never replayed against a changed schema. Client. (The
    server's own additive-only deploy gate bounds how far schemas drift under a live queue.)
11. **Poison writes**: server verdict → skip-and-bump (§2.5); un-encodable args terminal at
    enqueue. Both.
12. **Queue overflow**: bounded (configurable ceiling), oldest-evict with an observable
    settled-event even for awaiter-less hydrated records; advisory at 10% headroom. Client.
13. **`navigator.onLine` lies**: never gated on it — always-attempt + backoff + interval nudge;
    transport backoff already jittered (`transport.ts:71-75`). Client.
14. **No Background Sync off Chromium**: portable contract is drain-on-next-visit +
    reconnect-wake; SW drain is a follow-on enhancement, and if built, the record format +
    auth-token storage must be SW-readable (noted in the seam's design constraints). Client.
15. **Server timeline resets**: `known: false` on `Connect` under an asserted watermark =
    timeline break → `onClientReset`, fresh clientId, unsent re-seq, parked rejected loudly
    (§2.6). A deployment-id/epoch stamp on `ConnectAck` (the fleet already stamps deployment
    ids) hardens this — same-timeline proof before trusting a watermark echo. Both.
16. **Ack received, sync stream behind**: dequeue on ack, overlay drop on the ts-gate — the two
    are decoupled by design (§3.4); the G4 origin-frontier machinery covers the
    nothing-invalidated case. Client, on server-shipped rails.

## 9. Honest weaknesses

- **The v1 chain gap is real.** An app that genuinely needs offline create-then-edit as separate
  user actions cannot ship on v1 without composite-intent modeling. We claim the demand is
  unproven and the workaround idiomatic; a rival shipping ids now is betting the opposite — the
  judge should weigh that this bet is *reversible in our direction and not in theirs* (a shipped
  id-acceptance surface with forgery rules cannot be un-shipped).
- **Two check-before-build flags**: zero-document commits through the transactor for the poison
  advance (§2.5), and per-session frame-processing serialization for window tuning (§3.4).
  Neither moves the wire contract; both are named so the spec phase reads the code first.
- **Multi-node (B2b) watermark placement is deliberately unresolved** (§2.3) — defensible
  because the wire is topology-agnostic, but a rival may claim we deferred the hardest half;
  our answer is that B2b itself is unbuilt and *no* position can test that claim today
  (E5's own discipline: ACs are testable through shipped entrypoints).
- **Pipelined drain is less proven than Lunora's strict chain** — they pay one RTT per mutation
  for a reason (simplicity). Our gap-reject rewind is self-healing but adds a state machine; the
  benchmark (AC10.2) is the arbiter, and the window degrades gracefully to W=1 = Lunora's shape.
