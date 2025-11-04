# Critique — DX & product lens (offline outbox)

Adversarial critic for the durable-offline-outbox workflow. Lens: **the API each position makes
app developers write (what `examples/chat` gains offline), the Convex-migrant impact (Convex has
NO offline story — e5 R11 grid: "offline writes: no (in-flight promise only)" — so this is
greenfield DX with no parity constraint), the conflict-UX honesty (an offline edit rejected three
hours later: what does the USER see), when the R9 accessors arrive, and coexistence with an
external outbox layer (TanStack DB adapter).** Goal is falsification, not improvement. Code
claims are `file:line` against branch `scheduler-component`, re-read 2025-11-04 (chat example,
protocol, handler, delivery-policy, optimistic-store, react hooks); reference-clone claims cite
`.reference/<repo>/<path>:<line>` via the evidence corpus (e1–e5), which carries the primary
citations. Verdicts marked CONFIRMED (checked against source or a position's own text) or
PLAUSIBLE (reasoned; residual uncertainty flagged).

Sharpest results up front:

1. **The reload scenario is a fork, and each position names only the other side's failure.** A's
   no-cross-reload-rendering produces B's "deferred-double-entry generator" at the product level
   (user re-enters invisible edits). But B and C's layer-rebuild produces a **stuck visual
   duplicate in the single-offline-edit case** — the most common offline scenario there is —
   because a replay-ack advances no session version and the resubscribe baseline keeps `ts`
   (`packages/sync/src/handler.ts:262-266`). Neither B nor C names it; B markets its mechanism
   ("zero new gate semantics") as a win. (§1, CONFIRMED at mechanism level)
2. **A has the corpus's only version-skew double-apply hole.** A keeps `Connect` untouched and
   arms park-and-resend off the client's own fields, not a server capability proof — a new client
   against an old server resends into `handleMutation`'s unconditional execution
   (`handler.ts:275-283`; bare `JSON.parse` ignores the extra fields, `protocol.ts:74`). B and C
   both feature-detect via `ConnectAck`; A structurally cannot, because refusing to activate
   `Connect` IS its minimalism. (§2, CONFIRMED from A's own text)
3. **A's pause-by-default poison turns one bad write into "the app stopped syncing"** for every
   developer who hasn't wired `onMutationFailed` — and chat, the flagship example, is exactly the
   independent-writes app for which pause is wrong. Defaults are the product. (§3, CONFIRMED)
4. **All three ship `usePendingMutations` in-slice** — the R9 question is settled unanimously —
   but under A the accessor must carry the entire cross-reload visibility story: the app
   hand-renders pending data from `entry.args`, duplicating the updater logic the registry
   exists to centralize. A even ships the registry API with no v1 consumer. (§4, §7)
5. **All three are silent on external-outbox coexistence** (TanStack DB adapter), and the field's
   only shipping example needed two mechanisms for exactly this — Lunora suppresses its built-in
   queue when the TanStack executor is wired AND keeps an order-agnostic per-call dedup scheme
   the serialized watermark cannot serve (e4 §1.1, §1.7). (§8, CONFIRMED omission)

---

## 1. The reload fork: invisible re-entry (A) vs stuck duplicate (B, C)

The shipped baseline the positions extend: chat's send is
`useMutation(api.messages.send).withOptimisticUpdate(appendOptimistic)` with a module-scoped
updater using `store.placeholderId("messages")`/`store.now()` and the `PendingMessage`
type-widening recipe (`examples/chat/web/main.tsx:31-46`, list keyed on `m._id` at `:70`).

**Against A.** A §2.3 rules that hydrated entries drain as plain mutations, no layer — the user's
post-reload experience is "pending writes listed in `usePendingMutations` with 'syncing' status"
(position-a §2.3). For chat: five messages typed offline, reload, still offline — the message
list shows **none of them**. A status badge is not a message bubble. B's §1 walk-through is
correct at the product level: the user re-enters the work, reconnect commits both copies, and the
dedup layer "worked perfectly and the data is still wrong" (position-b §1). A's §10 answer
addresses the *rendering* gap ("correctness over spectacle") but never answers the *re-entry*
consequence — the double-data outcome is a data-integrity failure delivered by a slice whose
headline is exactly-once effects. To mitigate inside A's own rules, the app renders pending
bubbles by hand from `pendingMutations()` args — a second renderer per mutation, duplicating the
optimistic updater's logic (see §7). (CONFIRMED as a product-level consequence of A's own rule)

**Against B and C — the failure they don't name.** Both rebuild layers at hydrate for entries
that may have secretly committed (sent, committed, ack lost — AC2.1's own scenario). Walk the
*simplest* offline case: user makes ONE edit, transport dies after commit but before ack, tab
reloads, reconnects.

- The resubscribe baseline already contains the committed effect, and its Transition **keeps
  `ts`** — a query-set change bumps `querySet` only (`handler.ts:262-266`); the session starts at
  a fresh version (e1 §4) and the client's `observedTs` resets per session (e1 §1.3).
- The rebuilt layer re-adds the row on top of its own echo. Under C the layer's row carries a
  placeholder `_id` (`${entropy}:${table}:${n}`, `packages/client/src/optimistic-store.ts:82-86`)
  while the baseline row carries the real id — **two visually identical rows with different React
  keys**. Under B the promoted `placeholderId` mints the same real id as the committed row, but
  the updater is a query-result append (`[...list, row]`), so the array holds two rows with the
  SAME `_id` — a React duplicate-key warning plus the same visual dup.
- The drain resends; the replay-ack echoes the ORIGINAL commitTs (both positions, correctly, for
  the gate's sake). But a replay generates **no commit, hence no fan-out, hence no Transition**
  that raises the fresh session's `version.ts` to cover it — A's own §2.3 states this exact
  mechanism and it is right. `versionCoversCommit(originalCommitTs)` stays false until some
  *unrelated fresh commit* touches a subscribed query.
- With one queued entry and a quiet app — the solo-user single-edit case — nothing else commits.
  **The duplicate sticks indefinitely.**

C's §3.4 G4 note ("the drainer IS the origin session") covers fresh commits only; B's §2.1
step-5 fleet-lag justification covers a rare case by paying in the common one. B's proudest
sentence — "resume introduces zero new gate semantics" (position-b §2.1) — is the mechanism of
the bug: the sound fix is precisely ONE new drop trigger (settle-and-drop a layer when the
handshake/replay verdict proves the entry committed and the baseline postdates it), which is the
lmid-shape gate revisit the client-sync verdict already scheduled (verdict.md:154). C even
carries the needed datum on the wire (`ConnectAck.watermarkCommitTs`, position-c §2.1) and then
declines to use it as a drop trigger (§3.4 keeps overlay-drop on the ts-gate alone). (CONFIRMED
at mechanism level; the residual uncertainty is only whether the spec phase changes resubscribe
baseline stamping instead — either fix is one seam, but *as written* both positions ship the
window and neither discloses it.)

The honest fork, stated for the judge: A fails the reload-mid-offline user (re-entry → double
data, mitigated only by hand-built pending UI); B and C fail the ack-lost user (stuck duplicate,
mitigated only by a gate change neither proposes). These are complementary halves of one
requirement — cross-reload rendering with a commit-verdict drop trigger — and no position ships
both halves.

## 2. Position A's version-skew double-apply — minimalism eating its own correctness

A's park-and-resend swap arms "only when the entry carries clientId/seq" (position-a §6) and its
wire table keeps `Connect` untouched (§4). There is no server-capability proof anywhere in A's
text. Sequence: new client + old server (self-host reality — clients ship in app bundles, server
binaries lag; slice 6b hot-swaps functions, not the engine) → `Mutation{clientId, clientSeq}` →
old server's `parseClientMessage` is a bare `JSON.parse` (`protocol.ts:73-75`), unknown fields
ignored → `handleMutation` runs it unconditionally (`handler.ts:269-283`) → transport drops
before response → A parks (its fields are present!) → reconnect → resend → the old server **runs
it again**. Double-apply, from the position whose thesis is exactly-once effects.

B names feature detection explicitly ("a client that never receives `ConnectAck` … keeps today's
S4 fail-fast policy", position-b §2.5); C falls back wholesale ("against a server that never
answers `ConnectAck` … today's fail-fast policy", position-c §3.3). A cannot copy the fix without
activating `Connect` — which its §5.3 argues against as slice discipline. So the hole is not an
oversight; it is the cost of A's most-argued boundary, unpriced. (CONFIRMED from the three texts
plus the shipped parse/handler code)

## 3. The three-hours-later rejection: what the user actually sees

The requirement's own scar tissue (e2 §2.3, PowerSync: "the user who made the write may be gone
by the time it fails"; e4 §5, Redux-Offline's minutes-later ghost) makes this the honesty test.

- **A (default `pause`)**: the failed entry parks at the head; *every subsequent offline write
  stalls behind it* until app code calls `skip()`/`retry()`. A claims this "cannot wedge
  silently: durable state + refiring callback + visible accessors" (position-a §5.2) — but a
  callback nobody registered fires into the void, and an accessor nobody renders shows nothing.
  For the unwired app — every app in its first week — the user experience is: the app stopped
  syncing, no error, no cause visible (the failed edit was never rendered post-reload, per §1).
  A's philosophical case (later writes may be premised on the failed one) is real for workflow
  apps and wrong for chat, todo, notes — the app shapes this slice is for. Both Replicache and
  Zero mandate the opposite default and Replicache's word for A's default is "deadlock" (e2 §5);
  A cites both and defaults against them. `poisonPolicy: "skip"` being "one word away" concedes
  the mechanism and keeps the wrong default — defaults are the product. (CONFIRMED)
- **B / C (skip-and-record)**: other edits commit; the failed one settles terminal from a durable
  record; if the registry rendered it, the ghost row disappears at settle — the documented
  Replicache vanish, now *with* a durable inbox (`onMutationFailed` refires post-reload; C
  additionally echoes the recorded failure verdict on any resend from the same row family,
  position-c §2.5, so a second tab sees the same truth). Strictly more legible.
- **Shared gap**: under all three, the default user-visible affordance is *nothing* — everything
  routes through app-built UI. No position proposes even a dev-mode `console.error` for a
  terminal failure with no registered handler, which is a five-line courtesy the first bug
  report will demand. (CONFIRMED omission, all three)

## 4. The registry: one seam, three confusions

- **A ships a registry API with no consumer.** Position-a §2.3: the registry "ships as an API,
  but nothing breaks when an updater is unregistered" — yet A's own hydrate rule gives it nothing
  to do (no layer crosses reload; cross-reload rendering is a follow-on). An API that does
  nothing in v1 is negative DX: it must be documented, versioned, and explained-away. Either A
  wires it (then §1's duplicate analysis — which A itself articulates — applies to A too) or A
  should not ship it. Incoherent as written. (CONFIRMED from A's text)
- **C never answers the one-mutation-two-updaters question.** C registers at construction
  (`optimisticUpdates: { "messages:send": fn }`, position-c §3.2) AND keeps inline
  `withOptimisticUpdate` closures working for online use. So chat's `appendOptimistic` exists at
  the call site today (`main.tsx:50`) and must ALSO be registered for reload-survival. Does a
  live `mutation()` carrying a call-site closure consult the registry too (double-apply)? Does a
  live call with NO closure consult it (surprise optimism)? C specifies neither. The obvious
  answer (call-site wins; registry consulted only at hydrate) means the same updater logic lives
  in two places unless the docs teach "register once, chain never" — which is B's surface with
  extra steps. (CONFIRMED omission)
- **B bifurcates the docs we shipped last week.** `withOptimisticUpdate` chaining, the
  identity-stable callable contract (`packages/client/src/react.tsx:60-89`), the placeholder
  recipe — all just shipped and exemplified in chat. B demotes the chaining surface to
  "online-only legacy" (position-b §2.1) within one slice of shipping it, so the enduser docs
  must teach two authoring modes and when each silently loses durability. B's compat concession
  is honest but the churn is real and B does not price it. (CONFIRMED)

## 5. Client-supplied ids, DX-weighed — B undersells its best card and overplays its hand

Two genuine B wins the other positions under-answer:

- **Args-built-from-rendered-state.** The user taps an optimistic doc; the app calls
  `toggle({ id: doc._id })`. Under A/C that `_id` is a non-decodable placeholder barred from args
  — the developer must special-case "is this row pending?" at every interaction site (the
  `pending: true` recipe helps render it but not act on it). B dissolves the cliff: minted ids
  are real. This is the strongest DX argument in B's §1 and it survives attack.
- **Stable row identity across confirm.** Today confirm swaps placeholder→real `_id`, remounting
  the keyed row (`main.tsx:70`). B's promotion makes `_id` permanent from first render — kills
  the confirm-remount flicker class entirely. B never mentions this; it is B's most marketable
  user-visible improvement, unclaimed by its own author. (PLAUSIBLE — depends on the layer-swap
  path simplifying as B's §3 table says it does)

Against B: **shipping the rewrite fallback alongside client ids creates two id disciplines in
one docs set.** §2.3 ships the machinery PowerSync×Convex self-declared their #1 DX cost — as a
"safety net" for "apps mid-migration, code that never registered" — so the enduser docs must
explain when args are rewritten vs when ids are real, and the failure modes of each. C rejects
rewriting outright (position-c §1, "rejected outright, not deferred") — the cleaner product line.
And C's composite-intent answer ("create a thread and add its first message is ONE mutation",
position-c §5.1) is not a workaround but the existing Convex idiom — a migrant's app is already
written that way, because Convex ids are server-minted too. The v1 chain gap is real (C owns it,
§9) but it is a gap relative to B's future, not relative to the on-ramp. (CONFIRMED)

## 6. The greenfield question: does no-parity free us or tempt overdesign?

It frees us — and each position's temptation artifact is visible:

- **A**: the pause default (§3) — a philosophy optimized for an app class the slice's own
  examples don't contain; and the per-tab clientId's product face: A structurally forecloses
  cross-tab pending visibility of live entries (each tab a new client, no shared rendering path),
  scoped out as "R7.3 permitted" but never priced as UX.
- **B**: the rewrite fallback (§5) and the registry-primary docs churn (§4) — completeness for a
  population (mid-migration apps) that does not exist yet in a greenfield feature.
- **C**: the pipelined-window drain with gap-reject rewind — a performance state machine in v1
  where Lunora deliberately ships one-RTT-per-mutation for simplicity; C flags it itself
  (position-c §9) and keeps W=1 degradation, which is the right shape of honesty.

The constraint that DOES bind, which no position states as such: **the just-shipped optimistic
surface is now our own on-ramp**, and the outbox must not regress or bifurcate it. Chat's
`withOptimisticUpdate` + typed store + placeholder recipe (`main.tsx:31-50`) is what a migrant
learns in week one; C preserves it fully, B demotes it, A preserves it online and strands it at
reload. Greenfield means the *offline* semantics are ours to define — it does not mean the
authoring surface is free to churn. (Judgment, grounded in the shipped example)

## 7. Accessors: unanimous in-slice — the differentiator is the burden they carry

All three ship `client.pendingMutations()` / `usePendingMutations()` / `onMutationFailed`
in-slice (position-a §7 item 6; position-b §4.1; position-c §3.5) — nothing like it exists today
(the only `pendingMutations` in the tree is the client's private promise map,
`packages/client/src/client.ts:41`). The R9 timing question dissolves; what remains:

- Under **A**, the accessor is the *only* cross-reload visibility surface, so "show my five
  offline messages" means the app renders message bubbles from `entry.args` in a pending-tray —
  a hand-written second renderer per mutation whose logic must track the optimistic updater
  forever. That is the closure-duplication problem the registry was named to solve, reintroduced
  as an app obligation. (CONFIRMED consequence)
- Under **B/C**, pending data renders in place via the registry; the accessor serves status and
  failure UX only — the right division of labor.
- All three correctly reject Zero's two-promise DX with reasons (AC9.4 discharged).

## 8. TanStack-DB coexistence: unanimous silence, and the field already wrote the lesson

No position mentions TanStack DB or external outbox layers at all (grep over all three, zero
hits). This matters because the ecosystem motion is toward collection layers that own their own
durable queues — and Lunora, the pacing competitor, already hit both halves of the problem:

- **The two-queues hazard**: when the TanStack offline executor is wired, Lunora *suppresses* its
  built-in queue's IndexedDB default so a second, never-flushed durable copy cannot exist
  (`.reference/lunora/persistence.ts:172-176` via e4 §1.7). All three positions make durability
  opt-in per client config, which accidentally permits the right thing — but none states the
  rule, and a TanStack-DB-over-Stackbase adapter author gets no guidance that they must NOT
  enable our outbox under theirs.
- **The order-agnostic dedup gap**: an external queue (TanStack's executor, or any app-level
  retry) is not a FIFO drainer — it retries out of order. A and C's watermark 409s any gap
  (`OUT_OF_ORDER`), making the serialized protocol *unusable* as the external queue's
  idempotency backstop; Lunora ships a second, order-agnostic `(identity, mutationId)` scheme
  for precisely this coexistence (e4 §1.1 — "the two schemes share the dispatch path"). B's
  exact-match per-seq records, having traded away server-side gap rejection, are accidentally
  the closest fit for order-agnostic external callers — a genuine point for B that B never
  claims. The concrete missing API, under every position: an idempotency identity on the public
  `client.mutation()` (or documented `clientId/seq` pass-through) so an external queue can get
  exactly-once effects without adopting our drainer. (CONFIRMED omission, all three)

## 9. What the chat developer writes (concrete)

Baseline today: `main.tsx:14-56` — client construction, module-scoped updater, chained
`withOptimisticUpdate`, type-widened pending row.

- **A**: `+ outbox: indexedDBOutbox()` in construction; `+ poisonPolicy: "skip"` (mandatory for
  chat, see §3); optionally `onMutationFailed` + a hand-built pending-tray component rendering
  bubbles from args (mandatory for acceptable reload UX, §7). Render code unchanged; reload UX
  degraded unless the tray is built.
- **C**: `+ outbox` config; `+ optimisticUpdates: { "messages:send": appendOptimistic }` — the
  updater is already module-scoped, so registration is one line, but it now lives in BOTH the
  registry and the call-site chain until C answers §4's precedence question. Reload UX: messages
  visible, drain commits them; the §1 duplicate window applies to ack-lost sends.
- **B**: registration replaces chaining (`registerOptimistic`), construction changes, and the
  updater's `placeholderId` now mints real ids — the `pending` styling keeps the widening recipe
  but interaction with pending rows starts working. Best end-state; most churn from the shipped
  example; same §1 duplicate window.

## 10. Ranking

1. **C** — the only position whose offline story a Convex migrant can adopt without unlearning
   the just-shipped surface: chaining preserved, registration additive, skip-by-default progress,
   feature-detected fallback, composite-intent chains that match how Convex apps are already
   written, and R9 with verdict-replay. Its real failures — the §1 duplicate window, the §4
   two-updaters ambiguity, TanStack silence — are all resolvable in the spec without moving the
   architecture, and C already carries the wire datum (`watermarkCommitTs`) its own fix needs.
2. **B** — the best end-state DX in the corpus (client ids genuinely dissolve the interaction
   cliff and the confirm-remount; its dedup shape is accidentally the best external-queue fit),
   ranked second because its packaging spends migrant trust: docs bifurcation of a week-old
   surface, two id disciplines via the rewrite fallback, and the same §1 window marketed as a
   feature. Strip the rewrite fallback and land client ids as C's first follow-on and B's
   substance survives inside C's shape.
3. **A** — the cleanest server argument produces the worst product: post-reload invisibility
   regenerates the double-data UX the slice exists to kill, pause-by-default stalls every
   unwired app, the registry ships consumer-less, and the refusal to activate `Connect` leaves
   the corpus's only version-skew double-apply. A's genuinely superior micro-calls — overflow
   rejects the NEW enqueue with a live awaiter instead of silently evicting the oldest durable
   promise (position-a hazard 12), and the single-offline-edit ack-lost case renders correctly
   under A alone (§1) — belong in the winner's spec, not in a winning position.

Cross-cutting action items this critique surfaces, position-independent: (i) a commit-verdict
layer-drop trigger (or resubscribe-baseline ts stamping) so cross-reload rendering and the
ack-lost case are BOTH correct — the one genuinely new gate semantic this slice cannot dodge
(§1); (ii) server-capability feature detection is non-optional for whoever wins (§2); (iii)
default poison = skip-and-record, with `pause` as the option (§3); (iv) specify registry-vs-
closure precedence in one sentence (§4); (v) a dev-mode loud default for unhandled terminal
failures (§3); (vi) one paragraph in the spec on external-queue coexistence: suppress-our-outbox
guidance plus an idempotency identity on the public mutation API (§8).
