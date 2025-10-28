# VERDICT — client optimistic updates + offline sync

All load-bearing code claims in the critiques re-verified against the tree before judging (2025-10-16, branch `scheduler-component`): `MutationResponse` carries no ts (`packages/sync/src/protocol.ts:59-60`) while `handleMutation` destructures `commitTs` and discards it at the send site (`packages/sync/src/handler.ts:209-210`); the shipped fan-out path is the runtime drain calling `handler.notifyWrites(inv)` with **no** origin session (`packages/runtime-embedded/src/runtime.ts:459` sets `autoNotifyOnMutation: false`; drain at `runtime.ts:460-485`; `adapter.subscribe` payload at `runtime.ts:656-663` carries `{tables, ranges, commitTs}` only) — so the correctness critique's F1 is real: A and C's "~6-line" G4 fix branches on a parameter that is always `undefined`; the resubscribe Transition preserves the session's ts (`end = {querySet: start.querySet+1, ts: start.ts}`, `handler.ts:198-200`) — F3's reconnect ts:0 baseline is real; the backpressure controller drops frames of any type (`packages/sync/src/session-controllers.ts:76-95`); `runtime.ts:427` has the `?? 0n` fallback; the commit publish fires inside `commitWrite`'s stack as fire-and-forget (`packages/transactor/src/shard-writer.ts:370-377`); inbound messages are unawaited (`packages/cli/src/server.ts:293`); and the generated api has `Returns = any` on every function (`examples/chat/convex/_generated/api.d.ts:3-24`) — the DX critique's type-parity blind spot is real. The critiques argued about real code. Verdict follows.

---

# Position C's skeleton wins — as the **Gated Ledger**: Convex-parity layers over a serializable pending log, with B's determinism helpers grafted in and four server-side repairs the critiques made mandatory

## (a) Verdict and rationale

**Position C (layers now, log-ready seams) is the architecture. Position A's public surface is retained because C's surface *is* A's. Two of Position B's details are grafted in as mandatory (deterministic `placeholderId`/`now()` helpers; the serializable entry triple); B's registry is rejected as the v1 canonical surface. On top of the winning skeleton, the slice must land four server/protocol repairs no position priced correctly.**

All three critiques independently ranked C > A > B, for reasons that survive cross-examination:

- **The core loop is common and sound.** Apply-at-initiation → replay-survivors-over-fresh-base on every ingest → ts-gated drop survived every adversarial interleaving the correctness critique could construct against today's single-store, tail-serialized fan-out (including two-in-flight commit-order inversion via the unawaited `handleMessage`, `cli/server.ts:293`). The loop is not the decision; the representation and the protocol repairs are.
- **A is strictly dominated by C.** A-done-correctly already contains C's components (convex-js itself keeps a separate server-snapshot map plus an ordered pending array — e1 §2.2), but A leaves them anonymous — and its own forward-compat pitch fails on its own data structure (scope A1: `pendingUpdates` entries hold no `udfPath`/`args`, so "the pending array is precisely what an outbox later persists" persists nothing). A's precision brand took three verified hits in its own text: the unimplementable G4 siting (F1), the false-reject of committed mutations its promise-timing change manufactures (F2), and a self-contradictory sharding proof (F5: "no later than visibility" includes "before visibility"). A also leaves a dropped socket terminal — the most common real-world failure stays a hard error.
- **B is right about 2027 and wrong about the slice.** Its two genuinely correct calls — replay-deterministic placeholder minting (F4/I5: B is the *only* position whose example code satisfies the determinism rule all three state) and identity-confirmation as the primitive that survives multi-shard feed inversion (F5/I8) — are both stealable without the registry (the DX critique proved the helpers need only the per-entry `mutationId` and creation timestamp, both available under call-site closures). What is not stealable is B's cost structure: a canonical non-Convex surface at the exact feature migrants touch first (against the locked product-identity decision), two frozen public APIs for one feature, a G4 answer that is an unbounded wrong-guess wedge sold as bounded (F6 — "next invalidation of Q" may never come), a v1 "offline win" that is unreachable state (F7 — retained entries with no reconnect and no durability have no next connection), and its central "closures can't express entry states" dichotomy falsified by C's own S1 record (state and effect-representation are orthogonal).
- **C's failures are all fixable in place.** Its one correctness hole (F3, reconnect double-apply via the ts-preserving resubscribe baseline) closes with one stated rule (§(c) event 6 below); its untyped store sketch and unflagged promise-timing divergence are spec-level repairs; its "exactly two server changes" arithmetic was marketing (it's four — counted honestly in §(d)). Nothing in C's architecture moves.

The synthesis gate the correctness critique imposed is adopted in full: the slice is **not shippable as any position specced it** until (1) undroppable mutation responses, (2) G1-class subscribe/notify serialization, (3) a correctly-sited G4 frontier guarantee with an adapter-timing proof, and (4) B's deterministic placeholder/now helpers all land. Those are in the slice, below.

## (b) The design: data structures and v1 API surface

### Client-side structures (inside `StackbaseClient`, framework-agnostic)

**S1 — `MutationLog`.** One entry per unconfirmed mutation. The entry carries the serializable triple **from day one** (the scope critique's A1 amendment — this is what makes "the log is what an outbox later persists" true instead of marketing):

```ts
interface PendingMutation {
  requestId: string;                        // client-local; rides the existing wire field (protocol.ts:46)
  udfPath: string;
  args: JSONValue;                          // (requestId, udfPath, args) = the serializable triple
  update?: OptimisticUpdateFn;              // closure; looked up at replay, never serialized
  seed: { entropy: string; now: number };   // fixed at creation — feeds placeholderId()/now() (D2)
  touched: Set<string>;                     // query hashes the updater modified at initiation
  status:
    | { type: "unsent" }                    // queued, never hit the wire — safe to (re)send
    | { type: "inflight" }                  // sent, no response — outcome unknowable on disconnect
    | { type: "completed"; commitTs: number; completedAt: number }; // acked; layer held for the gate
}
```

**S2 — `LayeredQueryStore`.** Splits today's single `value` slot (`client.ts:26`) into `serverValue` (written only by server ingest) and `composedValue` (= ordered replay of surviving updates over the base; what listeners and the cached first delivery at `client.ts:75` see). Change detection by reference inequality, as convex-js does.

**S3 — the reconcile chokepoint.** One function through which every state change flows: server ingest, mutation initiation, mutation resolution, transport events. The sole place layers are applied, dropped, or replayed. The gate predicate is isolated behind `versionCoversCommit(version, commitTs)` so the sharded-frontier future changes one predicate, not the reconciler.

**S4 — `DeliveryPolicy`.** Routes transport events into log transitions. v1 policy in §(c) event 6.

### v1 public API (frozen at publish — chosen for the migration on-ramp)

```ts
// React — Convex-verbatim, opt-in per call site:
const send = useMutation(api.messages.send).withOptimisticUpdate((store, args) => {
  const list = store.getQuery(api.messages.list, { conversationId: args.conversationId });
  if (list === undefined) return;
  store.setQuery(api.messages.list, { conversationId: args.conversationId }, [
    ...list,
    { _id: store.placeholderId("messages"),   // deterministic across replays — NOT crypto.randomUUID()
      _creationTime: store.now(),             // fixed at entry creation — NOT Date.now()
      author: args.author, body: args.body },
  ]);
});

// Core client:
await client.mutation(api.messages.send, args, { optimisticUpdate });

// The store (typed — see the codegen prerequisite, §(e) D10):
interface OptimisticLocalStore {
  getQuery<Q>(ref: Q, args: FunctionArgs<Q>): FunctionReturnType<Q> | undefined;
  setQuery<Q>(ref: Q, args: FunctionArgs<Q>, value: FunctionReturnType<Q> | undefined): void;
  getAllQueries<Q>(ref: Q): Array<{ args: FunctionArgs<Q>; value: FunctionReturnType<Q> | undefined }>;
  placeholderId(table: string): string;   // deterministic per (entry, table, call-ordinal)
  now(): number;                          // entry-creation time, stable across replays
}
```

Plus: `MutationUndeliveredError` (typed unknown-outcome rejection); dev-mode `Object.freeze` on `getQuery` results (Convex's documented "will corrupt the client's internal state" footgun becomes an immediate throw); `webSocketTransport` gains reconnect + exponential backoff **default-on** (`{ reconnect: false }` opt-out — today's terminal-socket behavior is a product bug, not a contract worth preserving). Query identity is the existing hash `path + ":" + JSON.stringify(argsJson)` (`client.ts:63`); note for the spec: `react.tsx:24-25`'s `argsKey` is only an effect-dependency key, not the store identity (A mis-cited this).

**Rejected from v1:** B's `defineLocalMutators` registry as canonical surface (arrives later, if ever, as the reload-replay mechanism — statically registered updaters by `udfPath`, coexisting with call-site closures); `usePendingMutations`/`onMutationFailed`/`client.pendingMutations()` accessors (purely additive later over S1 — cut per the frozen-surface lens; the record shape is what makes them a follow-on instead of a redesign); optimistic **actions**, ever (no commitTs to gate on).

## (c) The reconciliation algorithm, precisely, against our protocol

State: `MutationLog` + per-subscription `{serverValue, composedValue}` + `this.version` + `maxObservedTs` (max `endVersion.ts` over transitions applied **in this session** — reset on reconnect, see event 6).

**1. Mutation initiation** (`client.ts:108-114`). Assign `requestId`; create the entry with its `seed`; run `update(storeView, args)` where the view reads composed state and its writes stack on top; record `touched`; if the updater throws, throw synchronously at the call site and send nothing. Fire listeners for touched queries only. If the socket is open: send `Mutation` and mark `inflight`; else mark `unsent` (retained for reconnect flush).

**2. Transition, contiguous** (`client.ts:161-166` bracket check unchanged). One atomic `reconcile` pass:
   a. `maxObservedTs = max(maxObservedTs, endVersion.ts)`.
   b. `dropIds` = every `completed` entry with `versionCoversCommit(maxObservedTs, commitTs)` (v1 predicate: `commitTs <= maxObservedTs`, guarded `commitTs > 0`).
   c. Apply modifications to `serverValue`s (`QueryUpdated` → base replace; `QueryFailed` → keep last base value, fire `onError` — unchanged semantics; `QueryRemoved` → keep).
   d. Drop `dropIds`; rebuild every touched subscription's `composedValue` = replay surviving updates in `requestId` order over the new base. **An updater that throws during replay drops its entry** (wrong guess against changed state), warns, and the rebuild continues — a mid-rebuild throw must never leave the composed store half-built.
   e. Fire listeners where the composed value changed (reference inequality).
   f. `version = endVersion`.
   Steps (b)+(c)+(d) in one synchronous pass are the no-flicker guarantee: the frame where the layer disappears is the frame where the authoritative rows appear — drop on **observed inclusion**, never on ack (the primitive every surveyed system converged on: Convex's `removeCompleted(ts)`, Electric's `write_id`, TanStack DB's txid match, PowerSync's write checkpoints — e2 §5.1).

**3. `MutationResponse` success, now carrying `ts`** (`client.ts:169-177` + wire change W1). **Resolve the promise now** (decision D3, §(e)). Then: if the entry has no updater or `touched` is empty → drop now (nothing rendered, nothing to protect). If `versionCoversCommit(maxObservedTs, ts)` already → drop now. If `ts <= 0` (the `runtime.ts:427` `?? 0n` fallback leaked) → warn + drop now (accept one-frame flicker over a wedge; server-side assertion makes this unreachable, §(d) item 4). Else mark `completed{commitTs: ts, completedAt}` and wait for the gate.

**4. `MutationResponse` failure.** Drop the entry, rebuild, reject the promise. Rollback is "stop replaying" — no inverse ops exist anywhere to get wrong.

**5. Gate timeout valve** (new — closes the residual of F6/§3.1 under any frame loss). A `completed` entry not gated within `gateTimeoutMs` (default 10s) of `completedAt` is dropped with a console warning. Combined with the server frontier guarantee (§(d) item 2) this should never fire in practice; it exists so that **no wrong guess and no lost frame can ever wedge a layer on screen indefinitely** — the failure class B's design left unbounded and A/C left to a mechanism that didn't exist.

**6. Transport close → `DeliveryPolicy`** (replaces `client.ts:235-241`; closes F3). At close: `unsent` entries are **retained**; `inflight` entries reject with `MutationUndeliveredError` and their layers drop (outcome genuinely unknowable — no server dedup exists, `handler.ts:204-217`; blind resend double-applies); `completed` entries are already resolved — their layers **drop too**. **No layer of any kind survives into a new session**: the ts-gate is only sound over a feed whose ts is monotone for this client, and a reconnect's resubscribe baseline arrives with the *fresh session's* ts (`handler.ts:198-200` preserves `start.ts` — effectively 0) while its rows already contain any just-committed write; carrying a completed layer across would replay it on top of its own echo (correctness I2). `maxObservedTs` resets with the session. On reconnect: re-send `SetAuth` (last token remembered), re-subscribe every live query (existing `resync()` path, `client.ts:228-232`), then flush `unsentInOrder()` FIFO.

**7. Resync in-session** (`client.ts:153-158, 220-233`). Unchanged; the adopted baseline replaces the base and the same rebuild runs. Layers are *not* dropped (same session, ts still monotone — the server's session version only advances). The G1 hardening (§(d) item 3) is what makes the adopted baseline trustworthy.

**8. `client.query()` one-shot** resolves with the **composed** view — a one-shot read can return speculative data. Decided and documented, not left ambient.

**Documented residual** (correctness §3.5): if the *confirming* Transition carries `QueryFailed` for the patched query, the gate closes (ts advanced) but the base kept the pre-write value — the committed, optimistically-shown write is invisible until the query recovers. Inherent to keep-last-value-on-error semantics; a docs line, not a code path.

## (d) Server work — four items, priced honestly (not "one field + six lines")

1. **W1: `MutationResponse` success gains `ts`** (`protocol.ts:59`; populated at `handler.ts:210` from the `commitTs` already destructured on the previous line, produced for local and forwarded commits at `runtime.ts:427`). With a **send-site assertion `commitTs > 0`** (dev throw / prod log) so the `?? 0n` fallback can never silently put a gate-breaking 0 on the wire. Backward compatible; old clients ignore it.

2. **The G4 origin-frontier guarantee — a real work item, not 6 lines.** Invariant to implement: *after any mutation from a sync session commits, that session's `version.ts` advances to ≥ its commitTs, and never before the session has been sent every modification that commit implies for its subscriptions.* F1 stands: `originSessionId` reaches `doNotifyWrites` on no shipped path (the only passing call site, `handler.ts:211-213`, is dead under `autoNotifyOnMutation: false`). **Primary siting (decided): thread an ephemeral origin tag through the commit fan-out** — `executor.run` opts → transactor `commitMeta` (the opts plumbing already exists: `shard-writer.ts:355` passes `{meta: commitMeta}`) → `OplogDelta` → `fanout.publish` → `adapter.subscribe` payload → the drain's queue entry → `notifyWrites(inv)`. Then the empty ts-advancing Transition (`{startVersion: session.version, endVersion: {querySet, ts: commitTs}, modifications: []}`) is emitted inside `doNotifyWrites` when the origin is absent from `bySession` — the one site where ordering relative to the write's own modifications is correct **by construction**, on both the sync-SQLite and async-`pg` docstores. The tag is in-memory fan-out metadata only (never persisted); a forwarded fleet mutation that cannot carry the tag falls back to a tail-enqueued origin-check gated on the drain's last-processed commitTs reaching the mutation's commitTs. The alternative siting (handler-local check enqueued by `handleMutation` onto the notify tail) is rejected as primary because its correctness depends on the docstore's publish having fired before `executor.run` returns — true for in-process SQLite, unverified for `pg`, and exactly the kind of scheduling-accident invariant this slice must stop leaning on. **An adapter-timing test on both docstores is mandatory either way.**

3. **G1 hardening: serialize `handleModifyQuerySet` with the notify tail, per session.** The subscribe/notify race is constructible from shipped code (`handler.ts:179-202` vs the tail at `handler.ts:241-245`): a concurrent invalidation can deliver a *newer* value and then the MQS response delivers an older one under contiguous brackets — the base regresses with no protocol signal. Pre-slice this was bounded staleness; **with layers it becomes "your own committed, optimistically-rendered write vanishes"** after the gate closed (correctness §3.2 falsified A's "orthogonal" claim — the slice worsens G1's user-visible severity, so G1 is in-slice). Mechanism: enqueue MQS processing onto `notifyTail` (subscribe latency behind pending notifies is the acceptable cost), or tag re-subscribe responses; the spec picks after a spike, the invariant is per-session monotone `serverValue`.

4. **Backpressure: exempt `MutationResponse`/`ActionResponse` from droppability** (`session-controllers.ts:76-95` currently drops any frame type). A dropped Transition self-heals by version-gap → resync; a dropped `MutationResponse` has no bracket and no retransmit — under this slice it would be an entry stuck `inflight` forever, replaying a possibly-double-applied effect on a healthy connection (correctness §3.1). Responses are small, rare, per-request; they always send. (The gate-timeout valve, §(c) event 5, is the client-side belt for any residual frame-loss path.)

Locked non-changes, pinned by tests: `excludeOriginFromTransition` stays off (`handler.ts:253` — the ts-gate consumes the origin's own fan-out, e1 H9); response-before-Transition ordering — today enforced only by drain scheduling and a comment (`runtime.ts:455-458`) — gets an explicit E2E through the real server so a future drain refactor cannot silently invert the gate's arming assumption (correctness §3.3).

## (e) Decisions on the contested contracts (each was left undecided or contradictory in the corpus)

- **D3 — Promise resolution: at `MutationResponse`, uniformly, for every mutation.** This is C's rule, today's shipped timing, and an **explicit, documented divergence from convex-js**, which resolves at the ts-gate (e1 §2.3). Rationale: gate-time resolution manufactures two user-facing catastrophe classes this protocol cannot yet exclude — F2's false-reject of a committed mutation on transport drop, and a promise that hangs forever if the gating frame is lost with no follow-on traffic — while its benefit (local-cache read-your-own-writes after `await`) is mostly delivered anyway: the composed view shows the write synchronously at initiation, and server-side RYOW holds for any subsequent query. Migration note required in docs: "differs from Convex: `await` confirms commit, not local-cache inclusion." A gate-time resolution option can be added additively later if demand shows.
- **D10 — Return-type codegen is IN the slice as a prerequisite work item.** Every position shipped runtime-shape parity with `Returns = any` (`api.d.ts:3-24`), which makes `localStore.getQuery` `Value`-soup and silently degrades a migrant's pasted update function — worse than an error. The slice generates `Returns` (inference from handler return types threaded into `api.d.ts`, or explicit `returns` validators — spec decides) and threads `FunctionArgs`/`FunctionReturnType` generics through the store and hooks. CLAUDE.md calls typed-client DX load-bearing; an untyped optimistic store is not parity.
- **D11 — Replay purity is enforced by API shape, not discipline.** Docs and examples use `store.placeholderId()`/`store.now()` exclusively; `crypto.randomUUID()`/`Date.now()` inside an updater is the documented anti-pattern (Convex's own docs example is a footgun we do not import — Replicache states the rule: ids generated inside a replayed function mint fresh per replay, e3 §1.3). Dev-mode freeze catches in-place mutation.
- **D12 — The sharded no-flicker question is answered by a mandated test, not a theorem.** Under the shipped 8-shard default, the drain is commit-completion order (`runtime.ts:460-485` FIFO), not commitTs order, so a higher-ts foreign frame closing the gate before the frame carrying my lower-ts write is possible in principle (scope A2; correctness F5 falsified A's contrary proof). Reachability is unconfirmed — the slice ships a concurrent cross-shard conformance/E2E test asserting drop-never-precedes-inclusion. If the test falsifies today's ordering, the v1 fix is server-side (drain ordering / frontier-gated session ts — the Fenced Frontier machinery already gives queries "everything ≤ ts reflected" semantics to build on); the long-term primitive is per-mutation identity confirmation on the wire (B's lmid-shape argument, validated by F5) — deferred until multi-node clients or the test demands it.
- **D13 — No optimistic actions**, ever. **D15 — `client.query()` returns the composed view**, documented. **D16 — `QueryFailed`-on-confirm degradation** documented.
- **Pending-row styling**: no `pending: true` planted on docs (it doesn't typecheck against `Doc<"...">` once D10 lands — the DX critique's hit on B). v1 recipe: a documented app-level type-widening pattern; a first-class metadata channel is a named follow-on.

## (f) e4's failure-mode catalog, number by number (the synthesis's answers)

1. **Refetch/invalidation revert-flicker** — structurally absent: no refetch primitive exists; the subscription stream is the sole reconcile path and every ingest rebuilds the whole log over the fresh base. TanStack's canonical bug is unrepresentable.
2. **Echo mismatch** — one atomic swap at the gated drop (§(c) event 2); server-computed fields snap once, never revert-then-fix. Residual: the snap is visible when the guess was wrong — inherent to optimism over arbitrary server mutations; documented.
3. **Ghost entries** — rollback is stop-replaying + full recompute from a base that never held the write (covers every projection; no second cache to miss); no minutes-old durable queue exists in v1; the gate-timeout valve caps even frame-loss ghosts at ~10s.
4. **Temp-id duplicate-on-confirm** — drop and authoritative ingest share one synchronous pass (replace-not-add, one frame); **and** `placeholderId` determinism kills the *pre-confirm* identity churn (F4) that A and C's own examples would have shipped (React row remount per unrelated ingest).
5. **Double-apply via independent feed** — one feed, one chokepoint; gate complementarity (replay iff base excludes the write) within a session; the F3 cross-session double-apply is closed by D4's drop-all-non-unsent-at-close rule.
6. **Non-independent stacking** — ordered replay over each new base is the only mode; Relay's counter double-count and TanStack's snapshot-erase are unrepresentable.
7. **Ambiguous failure / retry idempotency** — `inflight`-at-close rejects with typed `MutationUndeliveredError`; only never-sent entries resend (safe by construction); no automatic retry of sent mutations until server dedup exists (offline slice). Undroppable responses remove the phantom-inflight class.
8. **Offline ordering + dependency** — v1: unsent-only FIFO flush; temp placeholders barred from mutation args (create-then-edit awaits the create). Full answer (placeholder-arg rewrite or client-supplied ids) deferred with the durable outbox, where it is load-bearing.
9. **Failure UX** — mainstream bar (automatic total revert + rejected promise for the app's toast) plus the typed ambiguity error; observable-queue affordances are a named additive follow-on over S1.
10. **Cross-view consistency** — store-level in `StackbaseClient`: every subscriber of every patched query, including the cached first delivery, sees the composed view; `getAllQueries` covers arg-families (pagination). Bounded by which queries the updater patches — the honest Convex ceiling without a client replica, which the evidence says is a different product (e2 §2.4).

## (g) What ships vs deferred, with the honest cost of deferring

**The slice** (client `packages/client` + codegen + four `packages/sync`/`runtime-embedded` items + tests): S1–S4; the §(c) algorithm; `withOptimisticUpdate` + typed `OptimisticLocalStore` + `placeholderId`/`now` + dev-freeze; return-type codegen; W1 + origin-frontier + G1 serialization + response-undroppability; reconnect-by-default transport + resubscribe + SetAuth replay + unsent flush; `MutationUndeliveredError`; gate-timeout valve; docs (purity rules, temp-id constraints, promise-timing migration note, the two documented residuals). Reconnect is the designated cut line if the slice runs long — cutting it keeps D4's close rules and loses only the flush path (and un-proves S4; re-scope consciously if cut).

**Deferred, each with its receiving seam and its honest cost:**

| Deferred | Receiving seam | Honest cost of deferring |
|---|---|---|
| Durable offline outbox (reload/crash survival, resend of sent mutations) | S1 backing → IndexedDB; S4 policy → park-and-resend; registry-by-`udfPath` for reload replay | A network blip loses only `inflight` mutations (typed error, app-surfaced); a reload loses everything pending; hours-offline unsupported. Server bill when bought: per-client dedup atomic with commit (threads the sharded/fleet forward path), poison-pill semantics, session resumption — a transactor+sync slice, correctly refused as a rider on a client slice |
| Pending/failed queue accessors (`usePendingMutations` etc.) | S1 accessors | Apps hand-roll "saving…" from promises; purely additive later |
| Identity-confirmation on the wire (lmid-shape) | `versionCoversCommit` predicate + Transition payload | Gate correctness under feed inversion rests on the D12 test + single-node drain ordering; **must be revisited before a multi-node client ships** (B2b) |
| `maxObservedTimestamp` fast resume / session resumption | reconnect handshake (`Connect` is a reserved no-op today, `handler.ts:152`) | Reconnect re-sends full query results; fine at today's scale |
| Client-supplied ids for inserts | update-fn convention + id-codec acceptance | Offline create-then-edit chains impossible; online apps await the create |
| Pending-row metadata channel | store surface | Apps use the documented type-widening recipe |

Nothing in the deferred column reopens the §(c) algorithm. That property — C's signature — is why C won.

## (h) Test plan (mandated, not hand-waved — the harness gap all three positions shared)

`@stackbase/test`'s `t.subscribe` tests the *engine*; this feature is `StackbaseClient` internals. The tests must drive a **real `StackbaseClient` over a real `SyncProtocolHandler`**: loopback transport for gate logic (apply/confirm no-flicker asserted as "no listener frame ever shows the reverted state"; failure rollback; stacked A-fails-B-survives; temp-id atomic swap; wrong-guess self-heal via the origin frontier; gate-timeout valve; resync-with-pending-layers; drop-non-unsent-at-close), plus real-WebSocket E2Es in `packages/cli/test` (the `action-e2e.test.ts` pattern) for: response-before-Transition ordering pinned through the real server; reconnect kill → resubscribe → unsent flush; backpressure response-exemption; the G4 adapter-timing proof on **both** SQLite and `docstore-postgres`; and the D12 concurrent cross-shard no-flicker test. Spikes before estimating: queryId reuse across a fresh session (C §13); origin-tag plumbing depth through the fleet forward path.

## (i) Open questions the implementation spec must answer

1. **G4 plumbing shape**: exact field name/type for the ephemeral origin tag on `OplogDelta`/subscribe payload, and the fleet-forward fallback's re-enqueue mechanics (§(d) item 2).
2. **G1 mechanism choice**: MQS-on-the-notify-tail vs tagged re-subscribe responses — pick after the spike; the invariant (per-session monotone `serverValue`) is fixed.
3. **Return-type codegen mechanism**: handler-return-type inference vs explicit `returns` validators (interacts with the argument-validation slice's validator machinery).
4. **D12 test outcome**: if cross-shard feed inversion is reachable today, choose the server fix (ts-ordered drain vs frontier-gated session ts) before shipping.
5. **Re-render mitigation**: rebuild-replay creates fresh arrays each ingest, so patched-query subscribers re-render per ingest during pending windows even when deep-equal (DX critique §2) — measure in the chat example; structural sharing / deep-equal short-circuit on the replayed slice is the candidate fix, not required for correctness.
6. **`gateTimeoutMs` default** (10s proposed) and dev-freeze perf gating — measure on large results.
7. **Docs page structure**: purity rules, placeholder convention, promise-timing migration note, the `useQuery` args-change `undefined` flash (`react.tsx:35` — Convex-shared, explicitly out of scope, but the flicker chat users actually notice: one deliberate scope-exclusion sentence, per the DX critique).

**Bottom line:** ship C's layered, seam-named client with A's Convex-verbatim surface and B's determinism helpers; resolve promises at response; drop layers only on observed inclusion within a session and never across one; and pay for four small server repairs up front — because the critiques proved the "pure client-side layer" framing was the one part of this corpus that did not survive contact with the shipped code.
