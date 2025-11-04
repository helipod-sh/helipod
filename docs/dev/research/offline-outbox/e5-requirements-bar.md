# E5 — The requirements bar: what "solve all possible requirements, solid, best performant, unique" means, numbered

Evidence agent E5 for the durable-offline-outbox research workflow. Question: turn the user's
stated bar — **"solve all possible requirements, solid, best performant, unique"** — into a
numbered requirements catalog with testable acceptance criteria, grounded in (a) the client-sync
verdict's deferred table and its honest-cost column (`docs/dev/research/client-sync/verdict.md`
§(g)), (b) the optimistic spec's outbox-alignment section and its Lunora paragraph
(`docs/superpowers/specs/2025-10-16-optimistic-updates-design.md:112-126`), and (c) the shipped
S1–S4 reality (merged to main at `173fd14`, "Merge optimistic-updates: the Gated Ledger").

Sourcing: local claims cite `file:line` against the tree at 2025-11-04 (post-merge, the Gated
Ledger and fleet B3/B4 in `main`); prior-art claims cite the E2/E3/E4 evidence docs in
`docs/dev/research/client-sync/` (which carry the primary URLs) or a direct URL. Where a claim
is inference or training knowledge, it is flagged. One line-drift note up front: the verdict
cites `handler.ts:152` for the Connect no-op; on today's tree that case sits at
`packages/sync/src/handler.ts:197-198` — the seam is unchanged, the line moved.

---

## 0. Decomposing the bar, and the four schools the grids compare

### 0.1 The four lenses of the user's bar

- **"Solve all possible requirements"** = completeness against the verdict's own deferred
  table. The verdict §(g) priced the outbox honestly: *"per-client dedup atomic with commit
  (threads the sharded/fleet forward path), poison-pill semantics, session resumption — a
  transactor+sync slice, correctly refused as a rider on a client slice"* (verdict.md:152).
  Every row of that bill, plus the client half (durable S1, park-and-resend S4, reload replay),
  plus the classes the field's scar tissue documents (multi-tab, conflict UX, dependency
  chains), is in scope. Nothing gets the optimistic slice's "purely additive later" pass twice.
- **"Solid"** = every requirement has an acceptance criterion testable **through the shipped
  entrypoint** — the real `stackbase dev`/`serve` server in `packages/cli/test` (the
  `action-e2e.test.ts` / `optimistic-updates` E2E pattern, `ef5a5c6`), on **both** docstores
  where the transactor is involved, and across the shard rings (8-shard default) and the fleet
  `/_fleet/run` forward path (`ee/packages/fleet/src/forwarder.ts:5`) where delivery is involved.
  Mechanism unit tests alone do not discharge a criterion (project E2E rule).
- **"Best performant"** = the outbox must not tax the online path (enqueue latency, main-thread
  jank) and must drain a real backlog fast (R10's benchmark shape). Performance claims get
  measured, not asserted — the project already has a benchmark record discipline (`e3e2916`).
- **"Unique"** = R11. The honest competitive claim available is narrow and real: **nobody ships
  durable offline writes over a server-authoritative reactive-query backend that is also
  deploy-anywhere and write-sharded.** Every neighbor gives up at least one leg (§R11 grid).

### 0.2 The four schools (fixed row labels for every grid below)

Positions must fill each requirement's grid with our design's row; the four prior-art rows are
pre-filled here from E2/E3/E4:

| School | Members | One-line stance |
|---|---|---|
| **A — read-path sync + your-API writes** | Electric (current), TanStack DB | Server does reads only; optimistic overlay dropped on observed `txid`/`write_id`; durable offline = DIY Pattern 3 (localStorage), no owned server contract (e2 §1.2-1.4) |
| **B — client replica + durable row-op queue** | PowerSync (+ CouchDB ancestry) | Full local SQLite; persistent FIFO `ps_crud` queue; checkpoint-blocking ("never merge"); rejection = developer's problem, four sanctioned strategies (e2 §2.1-2.3) |
| **C — speculative-mutation rebase, per-client sequence** | Replicache, Zero, Linear, **Lunora** | Durable outbox of *intents* (named mutations); per-client `lastMutationID`/`clientSeq` watermark applied **atomically with effects**; skip-and-bump poison rule; rebase on pull (e3 §1, §2, §4; lunora.md §5) |
| **D — mainstream cache patterns** | Redux-Offline, Firebase, TanStack Query/Apollo/SWR | Either a persisted at-least-once action queue with app-authored rollback (Redux-Offline) or protocol-level latency compensation with queued pending writes (Firebase); the cache libraries have no durable story at all (e4 §1-6) |

The single most load-bearing prior-art fact, restated: school C's **Zero team — who built
Replicache's full offline support — deliberately shipped no offline writes** ("Supporting
offline writes in collaborative applications is inherently difficult", e3 §2.4). The bar "solve
all possible requirements" therefore does not mean indefinite-offline multi-master; it means
the bounded-offline intent-outbox done completely — the scope E2 §5.3 identified as honest and
E3 §5 identified as "the smallest credible upgrade toward offline that doesn't require
inverting the read model."

### 0.3 What already exists (the shipped S1–S4 baseline the outbox builds on)

- **S1 is outbox-shaped by construction.** `PendingMutation` carries the serializable triple
  `(requestId, udfPath, args)` (`packages/client/src/mutation-log.ts:14-33`), and `requestId`
  is deliberately an **opaque string** so the outbox slice can choose uuid vs monotone
  `clientSeq` without reshaping the record (`mutation-log.ts:16-18` — the spec's Lunora
  consequence (a), spec:122-124). The `update` closure is explicitly *not* serialized
  (`mutation-log.ts:23-25`) — reload replay of layers needs the registry-by-`udfPath`
  (verdict.md:152).
- **S4's close rules are the fail-fast policy the outbox swaps.** At transport close: `unsent`
  retained, `inflight` rejects `MutationUndeliveredError` + layer drops, no layer crosses a
  session (`packages/client/src/client.ts:314-319`, `delivery-policy.ts:8-11`); on reconnect,
  unsent entries flush FIFO reusing their original requestIds (`client.ts:331-341`).
- **The gate spine exists.** `MutationResponse` carries the real `commitTs` with a `> 0`
  invariant (`packages/sync/src/handler.ts:173-186,286`); `versionCoversCommit` is the isolated
  predicate (`packages/client/src/reconcile.ts:25`); the G4 origin-frontier (including the
  forwarded-fleet `pendingFrontiers` fallback, `handler.ts:106-109,288-293`) is live.
- **What does NOT exist:** any per-client server dedup — `handleMutation` runs
  `executor.runMutation` once per inbound frame, unconditionally (`handler.ts:269-296`); a
  blind resend of a sent mutation double-applies today, which is exactly why S4 fail-fasts
  `inflight` entries. The only dedup machinery in the tree is the fleet's `fleet_idempotency`
  commit guard — atomic INSERT that aborts the whole commit on a duplicate key
  (`ee/packages/fleet/test/idempotency.test.ts:70-101`) — keyed per *forward attempt*, not per
  client, and living in `ee/`. It is the shape precedent ("the B3 fleet_idempotency relative",
  spec:115), not the feature.

---

## The catalog

Numbering is stable — downstream positions and critiques cite by `R#`. Each requirement:
statement → acceptance criteria (AC) → the four-school grid row skeleton → our shipped baseline.

### R1 — Durability: pending mutations survive reload, crash, and (best-effort) eviction

A mutation accepted by `client.mutation()` while offline (or in flight at crash time) must
still exist — as an intent, with its args — after the page reloads, the tab crashes, or the
browser restarts. The S1 record is the persistence unit (the triple + status + seed;
`mutation-log.ts:14-33`).

**AC1.1** Enqueue offline → hard reload → reconnect: the mutation commits and its effect
appears in a live subscription, proven through a real-WS E2E.
**AC1.2** Kill the process/tab with entries in every status (`unsent`, `inflight`,
`completed`-ungated): after restart, no acknowledged-and-gated mutation is resent as new work
(dedup may absorb it, R2), no unsent/inflight intent is lost.
**AC1.3** Honesty clause: browser eviction of IndexedDB is best-effort by platform design —
the slice requests `navigator.storage.persist()` and documents that un-persisted storage can
be evicted under pressure ([MDN storage eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria));
eviction survival is NOT promisable and must not be marketed. (Flagged: platform behavior, not
our code.)
**AC1.4** Non-browser clients (Node/Bun — the client is framework-agnostic) get a pluggable
storage seam (memory default = today's behavior); durability is opt-in configuration, not a
hard browser dependency.

| School | One line |
|---|---|
| A | DIY — Pattern 3 persists the overlay store to localStorage in their example; nothing owned (e2 §1.2 P3) |
| B | Yes — `ps_crud` is a table in the local SQLite replica; queue survives restarts by construction (e2 §2.1) |
| C | Yes — Replicache: IndexedDB Client View + pending records, "hours to days" (e3 §1.4); Linear: `__transactions` IndexedDB outbox of intents, replayed by `fromSerializedData` on restart (e3 §4.3); Zero: deliberately none (e3 §2.4) |
| D | Redux-Offline: persisted outbox surviving app restarts (e4 §5); Firebase: pending writes queue across disconnects (e4 §6); cache libraries: nothing |

**Ours today:** nothing durable — the log is a `Map` (`mutation-log.ts:37`); a reload loses
everything pending (verdict.md:152, honest-cost column).

### R2 — Delivery: exactly-once EFFECT via server dedup, atomic with commit, through shards and the fleet forward path

The outbox makes sends at-least-once (that is what "durable + resend" means), so the server
must make effects at-most-once: a per-client watermark/dedup record whose write is **revealed
atomically with the mutation's effects in the same commit** — Replicache's contract verbatim
("The effects of a mutation … and the corresponding update to the lastMutationID must be
revealed atomically", e3 §1.5), Lunora's `clientId + clientSeq` watermark shipped
(lunora.md §5, §10), and the shape our `fleet_idempotency` guard already proves in miniature
(atomic INSERT aborts the whole commit on duplicate; stores `commit_ts` + `value_json` so a
duplicate can be answered with the original result —
`ee/packages/fleet/test/idempotency.test.ts:70-101`).

**AC2.1** Kill the transport after commit but before `MutationResponse` delivery; reconnect;
the outbox resends: the effect exists **exactly once** in the data, and the resend is acked
with the ORIGINAL commitTs (so the client's gate still works). E2E through the real server.
**AC2.2** The dedup record commits in the same atomic unit as the mutation's writes on **both**
docstores (SQLite and `docstore-postgres`) — no ack-before-commit window (PowerSync documents
the UI-revert failure when the ack outruns durability, e2 §2.2).
**AC2.3** Sharding: dedup holds when one client's successive mutations land on **different
shard rings** (8-shard default, one-doc-one-ring invariant). This is a genuine design tension
the positions must resolve, not hand-wave: a single global per-client watermark row would
serialize all of a client's mutations through one ring (recreating cross-ring coupling the
shards slice removed), while per-(client, ring) records change what "monotone per-client seq"
means. Lunora never faces it — the DO *is* the shard (lunora.md §3). Named open question; the
AC is only the observable property: no interleaving of resends across shards double-applies.
**AC2.4** Fleet: dedup holds through `/_fleet/run` forwarding (a resend that lands on a
different node than the original must still dedup — the guard must live at the owning shard's
commit point, not at the receiving handler).
**AC2.5** The dedup table has a bounded retention story (a watermark is O(1) per client;
a random-key dedup table grows — the spec mandates the head-to-head: Lunora's ordered
watermark vs random-key `fleet_idempotency` shape, spec:124-125).

| School | One line |
|---|---|
| A | Not owned — "write tracking" (a `write_id` column) is your API's job; Electric only promises you can *recognize* the write in the read stream (e2 §1.4) |
| B | Acked by your API (2xx); "assumes that once the client's upload succeeds, the data is in the backend" — the documented revert-flash gap when it isn't (e2 §2.2) |
| C | The defining feature — lmid/clientSeq atomic with effects (Replicache spec, e3 §1.5); Lunora: "`seq ≤ watermark` acked without re-running" (lunora.md §5) |
| D | Redux-Offline: at-least-once, idempotency explicitly punted to your effects (e4 §5); Firebase: protocol-internal (opaque) |

**Ours today:** none on the sync path (`handler.ts:269-296` — every inbound Mutation frame
executes); fleet-forward-retry dedup only, wrong key granularity, `ee/`-only.

### R3 — Ordering: per-client FIFO; no cross-client ordering promise

A client's queued mutations replay in enqueue order, and a later mutation never executes
before an earlier one from the same client has been applied-or-terminally-resolved (R5).
Cross-client ordering is the transactor's OCC business — the outbox promises nothing there.

**AC3.1** Queue m1..mN offline; reconnect: server applies them in order (observable via
commitTs monotonicity per client and via effects that depend on order).
**AC3.2** Out-of-order arrival (a retry racing a later send) cannot commit out of order —
either the client never pipelines past an unacked head, or the server rejects
`seq > watermark + 1` as Lunora does (lunora.md §5). The positions choose the mechanism; the
AC is the invariant.
**AC3.3** FIFO holds across a mid-drain disconnect (drain 3 of 7, drop, reconnect → 4..7, no
re-execution of 1..3 thanks to R2).

| School | One line |
|---|---|
| A | Not owned; TanStack DB serializes per-transaction persist handlers, ordering across offline restarts is DIY (e2 §1.3) |
| B | Strict FIFO upload queue + the blocking rule: no new checkpoint observed while the queue is non-empty (e2 §2.1) |
| C | Sequential per-client mutation ids; gap ⇒ wait (Replicache push rules, e3 §1.5); Lunora rejects out-of-order (lunora.md §5) |
| D | Redux-Offline: serial FIFO, documented (e4 §5) |

**Ours today:** FIFO for `unsent` flush only (`client.ts:331-341`); anything that reached the
wire is outside the promise (fail-fast S4).

### R4 — Dependency chains: create-then-edit offline (the client-supplied-id question)

An offline user creates a doc and edits it before reconnecting. The edit's args must reference
the create's id — but our ids are server-minted (docstore/id-codec), and the client only has
the deterministic placeholder (`packages/client/src/optimistic-store.ts` mints layer-local ids
from the entry seed). The verdict barred placeholders from mutation args and deferred the real
answer to this slice, "where it is load-bearing" (verdict.md:140,156).

Two known resolutions (positions must pick and defend): **(i) client-supplied real ids** —
school C's unanimous rule ("unique IDs should often be passed into mutators as parameters",
Replicache, e3 §1.3; Zero: client UUID/ulid "work much better with sync engines", e3 §2.3) —
requires the id-codec/docstore to accept client-minted ids with collision + forgery rules; or
**(ii) placeholder-arg rewrite** — the outbox rewrites queued args when the create's ack maps
placeholder→real id (PowerSync×Convex did UUID→`_id` mapping and called it "the most visible
DX cost of the integration", e2 §2.4).

**AC4.1** Offline create → edit-referencing-create → delete-of-something-else → reconnect:
all three commit correctly, in order, exactly once.
**AC4.2** The chain survives a reload between enqueue and drain (composition with R1 — this is
what kills naive in-memory id-mapping).
**AC4.3** If (i): server-side validation of client ids (format, table ownership, no
cross-tenant forgery) is specified and tested; if (ii): rewrite is atomic with the ack
processing and the rewritten entry re-persists before the dependent send.

| School | One line |
|---|---|
| A | Unaddressed (writes are your API); TanStack DB inherits your id scheme |
| B | Client-UUID column + server-side UUID→id mapping mutation — their #1 DX cost (e2 §2.4) |
| C | Solved by fiat: ids are client-generated args, no temp ids exist anywhere (e3 §1.3, §2.3) |
| D | Redux-Offline: app-managed temp ids reconciled in your `commit` reducer; dependent actions "need manual coordination" (e4 §5) |

**Ours today:** impossible — documented constraint "no placeholders in mutation args"
(spec:158-159); online apps await the create.

### R5 — Poison pills: a permanently-rejected mutation must not wedge the queue, and the app must see it

A queued mutation the server will never accept (validation failure, authz denial, doc deleted
— R8's conflicts land here too) must not block the FIFO forever. Replicache's rule is the
canonical answer: "ignore that mutation and increment the lastMutationID as if it were
applied" — skip-and-advance, atomically (e3 §1.5); Zero: "skips any mutations that throw" with
structured errors (e3 §2.3). PowerSync's four strategies show the axis of choice
(relax / block / dead-letter / discard) and the honest warning that a durable queue makes
rejection UX *strictly harder* — "the user who made the write may be gone by the time it
fails" (e2 §2.3).

**AC5.1** m2 of m1..m3 permanently rejects: m1, m3 commit; m2 is terminally-failed exactly once
(the skip is recorded in the same dedup record family as success, so a resend of m2 doesn't
re-execute it — R2 composes).
**AC5.2** Retryable vs permanent classification is explicit (transport/OCC-transient errors
retry with backoff; validation/authz/thrown-handler errors are permanent) — the scheduler
slice's retryable-check lesson applies (memory: runtime-validation follow-up).
**AC5.3** The app-visible contract: a mutation whose promise-holder is gone (reload happened)
still surfaces its terminal failure through the R9 queue accessors / an `onMutationFailed`-class
callback — a failed offline write must never *silently* vanish (Redux-Offline's documented
worst-case: item looks committed for minutes, then disappears with no explanation, e4 §5,
catalog #3/#9).
**AC5.4** A poison pill cannot wedge drain progress even across restarts (reload mid-wedge →
resume → still advances).

| School | One line |
|---|---|
| A | Per-write rollback handler removes the entry from the local store; queue semantics DIY (e2 §1.2 P3) |
| B | Developer chooses: block (wedges), dead-letter, discard, or prevent — "the developer's responsibility" (e2 §2.3) |
| C | Skip-and-bump-lmid, mandatory, atomic (e3 §1.5); structured error to the client (Zero, e3 §2.3) |
| D | Redux-Offline: retries exhaust → app-authored `rollback` action fires — minutes-later ghost UX (e4 §5) |

**Ours today:** N/A — nothing sent ever retries; server-side failure rejects the promise and
drops the layer immediately (`reconcile.ts` event 4; spec error table:134).

### R6 — Session resume: reconnect without full re-sync

Today every reconnect rebuilds every subscription from scratch (fresh session, resubscribe,
full query results — verdict.md:155 prices this "fine at today's scale"). An offline-capable
client reconnects far more often, and a drain-then-resync storm multiplies both. The reserved
seam is the `Connect` message — a no-op case on today's tree (`handler.ts:197-198`) — where a
resume token (`maxObservedTimestamp` / Lunora-style bookmark) belongs.

**AC6.1** Reconnect with N live subscriptions and an idle server: bytes on the wire are O(ack)
per unchanged subscription, not O(result) — measured, with the full-result fallback proven when
the server can't honor the token (Lunora: replay the gap from the op-log "or force a re-seed if
the op-log window was exceeded", lunora.md §4).
**AC6.2** Resume composes with the Gated Ledger's session rules: S4's "no layer crosses a
session" and the `maxObservedTs` reset (`client.ts:314-319`; verdict §(c) event 6) are
re-derived for a resumed session — a resumed session that IS ts-continuous may relax them; the
position must prove which invariant holds, not assume.
**AC6.3** Resume is an optimization, never a correctness dependency: every AC in R1-R5 passes
with resume disabled.

| School | One line |
|---|---|
| A | Shapes have offsets — HTTP long-poll resumes from a shape log position (e2 §1.1; inference from Shape docs) |
| B | Checkpoints/buckets diff from the last checkpoint; client never re-downloads settled state (e2 §2.1) |
| C | Replicache cookie (opaque incremental pull); Zero CVR per client ("reconnects send diffs", e3 §2.1); Lunora bookmark + op-log gap replay (lunora.md §4); Linear `lastSyncId` catch-up (e3 §4.2) |
| D | Firebase resumes internally (opaque); cache libraries refetch everything |

**Ours today:** none — resubscribe sends full results; `Connect` is the reserved no-op seam.

### R7 — Multi-tab: single drainer, shared visibility

Two tabs of the same app share one origin's IndexedDB. Without coordination, both drain the
same outbox (R2 makes it *correct* but doubles sends and interleaves FIFO heads) and neither
sees the other's pending writes.

**AC7.1** Exactly one tab drains at a time (leader election — Web Locks API is the platform
primitive; flagged: mechanism choice is the positions' call), with automatic takeover when the
leader closes mid-drain (proven: kill leader between m2 and m3; follower completes without
violating R2/R3).
**AC7.2** A mutation enqueued in tab A is visible in tab B's pending-queue accessors (R9) and
drains even if tab A closes before reconnect.
**AC7.3** Optimistic *layers* remain per-tab (they are closures over per-tab subscriptions —
`mutation-log.ts:23-25`); only the durable intent + its status are shared. The cross-tab
render of another tab's pending write arrives, if at all, via the registry-by-`udfPath`
replay — a position may scope this OUT with justification, but must say so explicitly.

| School | One line |
|---|---|
| A | Unaddressed in the write patterns (localStorage store is shared but uncoordinated) |
| B | SDK-managed on shared local SQLite (inference from architecture; not verified in fetched docs) |
| C | Replicache: "changes sync across tabs in the same browser profile even while offline" (e3 §1.4 — shared IndexedDB + leader election, the latter from training knowledge, flagged); Zero/Linear: shared local store |
| D | Redux-Offline: per-store, i.e. per-tab — duplicate drains are the app's problem |

**Ours today:** two tabs are two independent clients; no shared anything.

### R8 — Conflict UX: the offline write that no longer applies

Our replayed unit is a **named mutation re-executed server-side under OCC** — intent replay,
"strictly better conflict semantics than PUT/PATCH/DELETE upload" (e2 §5.2), and Replicache's
own doctrine: "the mutation *code* is the conflict-resolution policy" (e3 §1.2 —
`markComplete` of a deleted todo becomes a no-op *if the mutation is written that way*). But a
mutation that throws on the moved-on world is a poison pill (R5), and one that silently
no-ops may surprise the user hours later. The requirement is honesty in the contract plus
surfacing, not client-side merge.

**AC8.1** Documented taxonomy: replayed mutation (a) succeeds against new state, (b) no-ops
by its own logic, (c) permanently rejects → R5 path. Nothing else exists (no client merge, no
CRDT — the field's settled fork, e2 §5.4).
**AC8.2** Late failures surface with enough context to act on: the failed intent's
`(udfPath, args)`, enqueue time, and the server error reach the R9 accessors (PowerSync's
warning about the vanished user, e2 §2.3).
**AC8.3** The stale-optimism window is bounded: while offline, layers render from a base
frozen at disconnect time; docs must state that long-offline composed views are speculative,
and the pending-affordance recipe (verdict's type-widening note, verdict.md:129) is the
documented mitigation. (E4 catalog #2/#3 are the failure classes; the echo-snap on drain is
inherent and stays documented, not hidden.)
**AC8.4** Guardrail: queue-age/size advisory (the Lunora 10%-of-ceiling pattern,
lunora.md §10) — warn the app well before a week-old queue drains into "intent-replay
Russian roulette" (e2 §5.3).

| School | One line |
|---|---|
| A | "Conflicts are extremely rare and can be mitigated well by strategies like presence"; blunt rollback sanctioned (e2 §1.2) |
| B | Four rejection strategies, developer's choice; no merge — the blocking rule means the client never reconciles (e2 §2.1, §2.3) |
| C | Mutation-code-is-policy (Replicache); Zero's refusal of offline writes IS their conflict-UX answer (e3 §1.2, §2.4) |
| D | Redux-Offline: "conflict resolution … explicitly left to the app" (e4 §5); Firebase: last-write-wins per path (opaque) |

**Ours today:** N/A offline; online, OCC replay + immediate promise rejection.

### R9 — Observability: the queue is a first-class, subscribable app surface

The optimistic slice cut `usePendingMutations`/`onMutationFailed`/`client.pendingMutations()`
as "purely additive later over S1" (verdict.md:79,153). The outbox calls that bill due: a
durable queue whose promises die on reload *requires* a non-promise surface — pending
affordances (e4 catalog #3), failed-write recovery (R5.3/R8.2), and a sync-status indicator
are unbuildable without it.

**AC9.1** `client.pendingMutations()` + a React `usePendingMutations()` (reactive) exposing:
requestId, udfPath, args, status (now including `parked`/`draining`/`failed{error, at}`),
enqueue time — typed against the D10 codegen where possible.
**AC9.2** `onMutationFailed` (or equivalent event) fires for terminal failures with no living
promise-holder; delivery survives reload (fired from the durable record on resume).
**AC9.3** A dismissal/retry affordance for terminally-failed entries (the app decides UX; the
API must make "keep visible in an error state" — the beyond-mainstream bar e4 catalog #9 names
— buildable).
**AC9.4** Zero's two-promise DX (`.client` / `.server`, e3 §2.2) is evaluated as the shape for
"saving…" states — adopt or reject with reasons.

| School | One line |
|---|---|
| A | TanStack DB: transaction objects with state; Electric patterns: DIY |
| B | Upload-queue count/status APIs on the SDK (inference; not verified in fetched pages) |
| C | Zero: per-mutation `.client`/`.server` promises + structured errors (e3 §2.2-2.3); Linear: queue states drive its UI (e3 §4.1) |
| D | TanStack Query: `useMutationState` — pending variables readable anywhere (e4 §1b); Redux-Offline: outbox is inspectable store state |

**Ours today:** promises only; the S1 record shape was designed so these accessors are additive
(verdict.md:153).

### R10 — Performance: no online-path tax; measured drain throughput; no main-thread jank

**AC10.1** Enqueue overhead: making S1 durable must not block the optimistic apply — the
synchronous initiation path (apply layer → listeners fire, `client.ts:161-195`) stays
synchronous; persistence is async write-behind with a stated crash window (an entry accepted
but not yet flushed can be lost — bounded, documented, and shrunk to actual-IDB-commit before
`unsent`→wire transition). Added p50 latency to `client.mutation()` measured and budgeted
(target: sub-millisecond on the call path; the IDB write itself off it).
**AC10.2** Drain throughput benchmark (the shape): N=500 queued mutations, reconnect,
measure (a) time-to-empty, (b) longest main-thread block on the client (must not jank a
60fps frame budget — batched sends, chunked IDB reads), (c) server-side: the drain rides the
existing pipeline (group commit, B4) rather than N round-trips if the positions adopt
batching — Replicache batches pushes (e3 §1.5); Lunora watermarks make batches safe.
Numbers land in the benchmark record (the `e3e2916` discipline), run against the real server.
**AC10.3** Reconnect-storm composition: drain + resubscribe + (R6) resume together on one
connection do not violate the backpressure caps (`c46e24d` — undroppable-frame overflow
terminates the session; the drain must pace itself under that cap).
**AC10.4** Dedup-check cost on the server is O(1) per mutation (watermark compare), not a
table scan; retention bounded (R2.5).

| School | One line |
|---|---|
| A | "Combining data on-read makes local reads slightly slower" — their honest P3 cost (e2 §1.2); no drain story owned |
| B | Checkpoint-blocking trades read freshness for zero merge cost; uploads batched by the SDK (e2 §2.1) |
| C | Replicache batches pending mutations per push (e3 §1.5); Zero built IVM precisely for incremental cost (e3 §2.1); Linear batches same-event-loop transactions (`batchIndex`, e3 §4.1) |
| D | Redux-Offline: serial one-at-a-time — the slowest possible drain; fine for its scale |

**Ours today:** no queue to drain; the online path's numbers are the baseline the outbox must
not regress.

### R11 — Uniqueness: the claim, stated precisely enough to be checkable

The claim the slice can honestly make when R1-R10 land: **the first durable offline outbox
with exactly-once effects over a server-authoritative reactive-query backend that you can
deploy anywhere (laptop/VPS/Docker/binary) and that write-shards.** Each neighbor concedes a
leg:

| Neighbor | What they have | The leg they concede |
|---|---|---|
| **Lunora** | The full story: clientSeq watermarks, offline queue, optimistic, bookmarks (lunora.md §5) | **Cloudflare-locked** — "No Cloudflare account, no Lunora — no local-first-server, laptop, VPS, or air-gapped story" (lunora.md §11); alpha |
| **Zero/Replicache** | The canonical intent-outbox + lmid contract | **Own client store substrate** (Client View / CVR+ZQL replica — a different read model, e3 §1.5, §2.1), and Zero shipped **no offline writes at all** (e3 §2.4); server contract is BYO-backend, not a BaaS |
| **Electric** | Overlay + txid matching via TanStack DB | **Reads only** — "Electric does not do write-path sync" (e2 §1.1); writes/dedup/offline are your API's problem |
| **PowerSync** | Durable queue + checkpoints, rigorous | **Client-replica model** — read path rewritten into local SQLite + sync rules; "the biggest piece of migration work" on a Convex-shaped app (e2 §2.4) |
| **Convex** | `withOptimisticUpdate` layers | **No durable outbox** — offline writes: "no (in-flight promise only)" (e3 appendix); closed-source cloud for the server half |
| **Supabase/Firebase** | Firebase: latency compensation, 10+ years old | Firebase: proprietary, data-patch writes not server functions (e4 §6); Supabase: "no story" (e4 §7) |

**AC11.1** The claim is written with its qualifiers (bounded offline, not multi-master; web
durability best-effort per R1.3) — no marketing drift.
**AC11.2** The differentiator that makes it defensible is the *combination*, and the
combination has a test: the flagship E2E runs the same app code through (a) SQLite single
binary and (b) Postgres + fleet + shards, offline-queue → reconnect → exactly-once drain on
both. Nobody else in the table can run that pair at all.
**AC11.3** Lunora is tracked as the pacing competitor (alpha today, same category): the
watermark head-to-head (R2.5) and the D12 lmid revisit note (spec:125-126) both name it —
if it ships v1 first, the uniqueness sentence changes, not the requirements.

---

## Cross-cutting acceptance discipline (applies to every R)

1. **E2E through the shipped entrypoint** — every AC involving the server runs against a real
   `stackbase dev`/`serve` process (`packages/cli/test`), per the project's proven rule that
   composed-path bugs hide from mechanism tests.
2. **Both docstores** for anything touching the commit path (R2, R5, R6) — the G4
   adapter-timing precedent (spec:80-81).
3. **Shards + fleet** for anything touching delivery (R2, R3) — the whole-branch reviews of
   B2a/B3 caught composed-path blockers every time; the outbox threads BOTH.
4. **No door-closing check** — the spec's outbox-alignment table (spec:112-117) ran the
   *forward* direction (optimistic slice must not block the outbox); this catalog is the
   *backward* direction: each position must show which shipped seam (S1 triple, S4 policy,
   `versionCoversCommit`, Connect no-op, registry-by-udfPath slot) receives each requirement,
   or say honestly that a seam is missing and price the new one.
