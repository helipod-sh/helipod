# Critique — scope & honesty lens

Critic agent (scope + honesty) for the client-sync adversarial workflow. Mandate: falsify, not improve. Questions asked of each position: what genuinely ships in one review-gated slice at this repo's demonstrated slice sizes; where the position hides work; which claims are YAGNI dressed as foresight; and — because packaging/publishing is deliberately last, so the client API published then is frozen-ish — which position's public surface survives the offline future without breaking changes, and which pays a permanent tax for a future that may never arrive.

Calibration first, because "one slice" is not an abstract unit here. This repo ships large slices: the whole `@stackbase/workflow` component plus saga in two slices, file storage with two blob adapters + a reaper + a MinIO container gate in one, write-sharding B1+B2a in two. By raw size, **all three positions fit one slice**. So slice-size arguments between them are mostly theater; the real differentiators are (a) frozen public API surface, (b) hidden server/infra prerequisites, (c) test-surface honesty. The repo's own recurring lesson (memory: every slice's final whole-branch review caught composed-path blockers task reviews missed) means every unit of extra scope is also extra composed-path risk.

Code claims below verified against branch `scheduler-component`: `packages/client/src/client.ts` (242 LOC total — the entire client), `packages/sync/src/protocol.ts:59` (no ts on `MutationResponse`), `packages/sync/src/handler.ts:209-217` (commitTs in hand, discarded; no requestId dedup), `handler.ts:241-277` (tail-serialized fan-out, `endVersion.ts = invalidation.commitTs` at :273), `packages/runtime-embedded/src/runtime.ts:427` (commitTs threading), `runtime.ts:455-485` (response-before-transition is enforced by drain scheduling + a comment, nothing else).

---

## 1. Position A — smallest honest slice, but two of its proudest claims don't hold as written

### A1. The "on-ramp, not a dead end" pitch rests on a data structure that cannot do the job (honesty, not architecture)

A's §6 deferred list says the offline outbox "layers on this design without inverting anything: **the pending array is precisely what an outbox later persists**." But A's own state definition (§3) is:

```ts
pendingUpdates: Array<{ mutationId: number; update: OptimisticUpdateFn; status: ... }>
```

No `udfPath`. No `args`. An array of closures persists nothing. As specified, the outbox-forward-compat claim is **false**: to persist or resend anything, the entry must also record the serializable `(requestId, udfPath, args)` triple — which is exactly C's S1 record and B's LogEntry core. The fix is invisible (record two more fields at H1, `client.ts:108-114`, where both are in hand), so this is not a rebuild-later argument for B — but it is a genuine honesty defect: A argues forward-compatibility from a structure that doesn't have it, and nobody would catch this at review time from the prose. If A is chosen, the slice spec must mandate the triple on the entry, or the position's own §6 is marketing.

### A2. The G6 claim proves no-wedge, not no-flicker — and sharding is SHIPPED, not future

A §3 ("Sharded ts caveat") and §8 claim the `maxObservedTs` gate "survives non-monotonic sharded commitTs." The proof offered: the Transition carrying my write has `endVersion.ts >= my commitTs`, so the gate closes *no later than* the write becomes visible. Correct — and it proves only the no-wedge direction. The no-flicker invariant needs the converse: the gate must not close *earlier*, on an unrelated higher-ts transition that does **not** carry my write. Under the shipped 8-shard default (B2a is live; per-shard commit-connection pool), the runtime's invalidation queue drains in **commit-completion order**, not commitTs order (`runtime.ts:460-485` — FIFO `queue.shift()`), and the handler applies `endVersion.ts = invalidation.commitTs` per transition (`handler.ts:273`) with only a bracket-contiguity check client-side (`client.ts:161` — equality, not monotonicity). So a session can in principle observe: unrelated shard-X commit at ts=100 → transition applied, `maxObservedTs=100` → my shard-Y write (commitTs=90) drops from the pending array **before** the transition carrying its rows arrives → one reverted frame. That is precisely the flicker A's §4.3 declares "impossible-by-construction."

Uncertainty flagged honestly: whether this reorder is reachable depends on how close store-side ts allocation is to commit-completion/enqueue order (Fenced Frontier B1 store-allocates ts; the race window is narrow). Unconfirmed either way — which is the point. A states a single-node theorem in shard-general language. The slice, whichever position wins, needs a concurrent-cross-shard no-flicker conformance test, or the gate needs a transition-carries-my-write refinement now. (C at least isolates the predicate behind `versionCoversCommit` and flags it, §9; B's lmid argument is *about* this case — see B3 below for why that still doesn't buy B's conclusion.)

### A3. The "6 lines" G4 fix is priced at happy-path only

The empty ts-advancing Transition to an unaffected origin interleaves with `handleModifyQuerySet`'s querySet bump — those two paths are not mutually serialized (e1 G1; `handler.ts:179-202` vs the notify tail at :241-245). An empty transition racing a query-set change produces a startVersion mismatch → client resync. Not incorrect (resync is the designed degradation), but it adds a new resync trigger on the hot mutation path, and "~6 lines" prices none of it. C schedules G1 hardening for exactly this reason; A doesn't mention the interaction.

### A4. The promise-timing change has an unexamined false-failure window

A resolves opted-in mutation promises at drop-time (§3 event 4, flagged as Convex parity). New window A never examines: `MutationResponse{success}` arrives, the transport drops before the gating Transition → `onTransportClosed` (`client.ts:235-241`) rejects a promise for a mutation the server **confirmed committed**. Today that ambiguity exists only for genuinely-unacked sends; A extends it to acked ones. Convex may share the defect; "parity" is not an answer a review should accept without the case being written down. Note also that A and C silently disagree here — see cross-cutting §5.

### A5. What A gets right on this lens

Smallest public surface (Convex-verbatim, opt-in per callsite, hooks unchanged), the most honest deferral list in the corpus (each deferred item names its server prerequisite), and the correct refusal of auto-retry without server dedup. The ~250-350 LOC estimate would more than double the 242-LOC client and touches its entire hot path (subscribe's cached delivery, applyModifications, mutation, close) — optimistic, but within this repo's slice norms.

---

## 2. Position B — right about the record shape, wrong about almost everything that makes it a distinct position

### B1. "The record shape costs ~zero extra now" counts only the loop code

The loop is identical (e3 §5, conceded by all). What B actually spends now, and never prices: **two public APIs for one feature in v1** — the canonical `defineLocalMutators` registry *plus* `.withOptimisticUpdate` compat sugar — both frozen at publish; plus `usePendingMutations`, `onMutationFailed`, `placeholderId`, `store.now()`, entry-state semantics, and a per-entry `dropOnResponse` escape hatch. Each is docs, teaching, conformance tests, and frozen surface. For a project whose locked decision is that DX is the product and whose product-identity decision makes Convex-parity the migration on-ramp, API surface is the scarce resource — and B's canonical surface lands migrating Convex users on a **non-Convex optimism API** on day one. `stackbase migrate` becomes "your optimistic updates work, but the documented way is this other registry thing." That is a permanent tax paid immediately, for offline — the feature Zero's team (maximum scar tissue) explicitly declined to build (e3 §2.4) and for which there is zero demand signal.

### B2. B's sharpest structural claim is falsified inside this corpus

B §9.1/§7: closures "can't even express" entry states; never-sent-vs-inflight survival is something "a closure model structurally cannot offer." C's S1 `PendingMutation` (position-c §4) carries `status: unsent | inflight | completed` **with** a closure-valued `update?` field and a serializable `(requestId, udfPath, args)` triple beside it. Entry identity/state and effect representation are orthogonal; B's argument conflates them. The "observable queue" (pending badges, failure entries) is likewise available to any position that records the triple — it's an accessor over the log, not a property of registries.

### B3. "Reconnect alone forces the slice-2 server contract" is false — C is the counterexample

B §4/§9.2 argues W2 dedup is owed the moment reconnect ships, because convex-js reissues outstanding mutations on reconnect (e1 §2.4). But reissue-of-sent is a *policy choice*, not a consequence of reconnect: C's reconnect resends only never-sent entries and rejects inflight with a typed error — reconnect shipped safely against today's dedup-free `handleMutation` (`handler.ts:204-217`). B uses the claimed inevitability of W2/W3/W4 — a per-client dedup table written inside the OCC transaction, poison-pill semantics, session resume, all threading through the sharded/fleet write path currently under active construction — to justify slice-1's shape. Tomorrow's bill justifying today's purchase is the exact YAGNI pattern, and the bill itself is a transactor slice wearing a client slice's name tag.

### B4. B's G4 answer trades product correctness for a talking point

To keep "slice 1 needs exactly ONE wire field," B answers G4 client-side: a wrong-guess entry (effect touched query Q; the real write didn't invalidate Q) is held **until Q's next unrelated invalidation** — unbounded on a quiet app — with a per-entry `dropOnResponse` flag as the escape hatch, i.e. a correctness burden exported to app developers. A and C close the same hole with ~6 server lines. Refusing a 6-line server change while proposing a multi-part server subsystem for slice 2 is scope theater: the position optimizes the *count* of slice-1 server changes, not the product.

### B5. Where B genuinely lands a hit (credit where due)

`placeholderId(mutationId, table, ordinal)` fixes a real defect that A and C both copy verbatim from Convex's docs: their example code mints `crypto.randomUUID()` **inside** the update function (position-a §2, position-c §3), which their own replay rule (updates re-run on every ingest — A §4.1's corollary, e1 §2.2) makes non-deterministic — the temp row's `_id` churns on every unrelated Transition while pending, remounting the React row each time. A §4.1 states the purity rule and A §2 violates it in the same document. B's fix needs no registry — "mint the id once at initiation, close over it" is a docs-level convention any position can adopt — but B is the only position that noticed. Similarly, B is the only position to specify entry-level `store.now()` freezing, closing the same replay-drift class for `_creationTime`.

### B6. B leaves an actual public contract unstated

When does the mutation promise resolve? §1.3 shows `await send(...)`; §2 says failure rejects and success marks `completed` and waits for the gate — resolution timing is never specified. For a position whose whole pitch is "design the durable contract on purpose," leaving the most-observed client contract (promise semantics) unwritten is a telling gap.

---

## 3. Position C — the strongest deferral story, dinged for its own marketing arithmetic

### C1. "Exactly TWO server changes" is contradicted by C's own slice list

§9's headline: two server changes, both protocol-completions. §10's slice list includes "**G1 resync-baseline hardening**" — serializing `handleModifyQuerySet` with the notify tail, or tagging re-subscribe responses. That is a third server change, and the subtlest of the three: a concurrency fix in the handler's core, exactly the class of change (composed-path race) that this repo's whole-branch reviews keep catching late. The hardening is *defensible* (C's reconnect makes resync frequent, so G1 stops being hypothetical — the reasoning is sound), but the arithmetic is marketing. Say three.

### C2. C bundles a second feature into "one slice" while indicting B for overbuilding

`reconnectingWebSocketTransport` + resubscribe + SetAuth replay + unsent-outbox flush + `MutationUndeliveredError` + G1 hardening is a reconnect mini-slice riding along. On demand it's justifiable — a dropped socket is *terminal* today (`transport.ts:55-60`; the app must construct a new client), arguably a worse product gap than missing optimism. But the tension with C's anti-B rhetoric is real, and the hidden cost is test surface: reconnect cannot be exercised through the loopback transport; per this repo's own e2e-through-shipped-entrypoint lesson it needs a real-WebSocket kill/reconnect E2E in `packages/cli/test` (the `action-e2e.test.ts` pattern), which C never names. C does honestly flag the queryId-reuse spike (§13) — the only position to flag an estimate risk at all. Note the coupling: if the slice runs long, the natural cut is reconnect — and cutting it un-proves S4, the one seam that is otherwise speculation (S1–S3 are genuinely near-free: convex-js itself keeps the same three structures, e1 §2.2). The "seams proven in v1" claim is load-bearing on the bundle surviving review intact.

### C3. Small frozen-surface leaks

`client.pendingMutations()` (§8, "count + statuses") is an underspecified accessor frozen at publish; it is purely additive later and should be cut from v1. `MutationUndeliveredError` is worth freezing (it names a real ambiguity — e4 #7). Dev-mode `Object.freeze` is flagged with its perf caveat — fine.

### C4. What survives scrutiny

The core claim — a correct implementation of A already contains S1/S2/S3, so naming them costs three interface declarations — survives; A1 above is the demonstration (A's unnamed pending array is *missing fields C's named one has*). The deferred table (§10) is the only one in the corpus where every deferred item maps to a named seam plus a named server prerequisite, and none reopens the reconciliation algorithm. That is exactly what the frozen-API lens wants to see.

---

## 4. Cross-cutting findings (all three positions)

1. **The no-flicker invariant under the shipped sharded transactor is unproven in all three.** Every position's ts-gate (A's `maxObservedTs`, B's `endVersion.ts >= commitTs`, C's `versionCoversCommit`) drops early if a higher-ts unrelated transition precedes the origin-write transition on one session feed; drain order is commit-completion order (`runtime.ts:460-485`), not ts order. All three cite e1 G6 as a *future multi-node* concern; 8 shards is the default **today**. Reachability unconfirmed (narrow race, store-side ts allocation) — the slice must test it, not assume it.
2. **The response-before-transition ordering is load-bearing for every position and pinned only by a comment** (`runtime.ts:455-458`). Whichever design ships, an E2E must assert it through the real server, or a future drain refactor silently breaks the gate's arming assumption.
3. **All three hand-wave the test harness.** "@stackbase/test conformance via `t.subscribe`" tests the *engine*; the feature under test is `StackbaseClient` internals (composed views, gate, listener-frame atomicity). The tests must drive a real `StackbaseClient` over a real `SyncProtocolHandler` — loopback for gate logic, real WS for ordering/reconnect. No position specifies this plumbing.
4. **The temp-id example defect** (see B5): A's and C's example code contradicts their own purity rule. Adopt B's mint-outside-the-closure convention regardless of which position wins.
5. **A and C silently disagree on promise-resolution timing** — A resolves at drop (Convex parity, RYOW, plus the A4 false-failure window), C resolves at `MutationResponse` (§5 step 3, today's timing, no RYOW). Neither flags the other. This is a frozen public semantic, arguably the most user-observable contract in the whole slice, and the corpus leaves it undecided. The synthesis must decide it explicitly.
6. **Frozen-API scorecard** (packaging-last lens): A freezes Convex-parity + a timing change; C freezes parity + one typed error (+ one cuttable accessor); B freezes a canonical non-parity registry + a duplicate compat API. If offline never ships — Zero's precedent says that outcome is live — B's tax is permanent; A/C pay later, additively (reload-replay eventually wants statically-registered updaters by udfPath, which C's deferred table names and which can coexist with call-site closures). The minimum surface that survives all futures: **parity `.withOptimisticUpdate`, an internal entry carrying the serializable triple (C's S1), and B's deterministic-placeholder convention.**

---

## 5. Ranking (this lens only)

1. **C** — the only position whose deferred list maps every item to a named seam + named server prerequisite with no API breaks, and the most honest about its own uncertainties (spike flags, predicate seam); dinged for "exactly two server changes" arithmetic (it's three) and for bundling a reconnect mini-slice while indicting B's bundling.
2. **A** — the smallest honest slice and the right frozen public API, but its forward-compat pitch rests on a data structure that lacks the fields to deliver it (A1), and it markets a single-node no-flicker theorem as shard-general (A2); choosable only with the triple-on-entry and shard-test amendments.
3. **B** — right about the record shape and the only position to catch the temp-id replay defect, but its two load-bearing structural claims (closures-can't-have-states, reconnect-forces-dedup) are falsified within this corpus, its G4 answer trades product correctness for a wire-change talking point, and it spends permanent canonical-API surface — against the locked product-identity decision — on a future the most-scarred team in the field declined to build.
