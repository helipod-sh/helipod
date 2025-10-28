# Position A — Convex-parity optimistic layers: `withOptimisticUpdate`, ts-gated drop, online-only

**Claim:** ship `withOptimisticUpdate` exactly as Convex defines it — an ordered stack of optimistic-update layers over the client's existing query-result cache, each layer dropped atomically when a server `Transition` with `endVersion.ts >= mutationCommitTs` is applied. Online-only: a disconnected mutation fails fast (as it does today, `packages/client/src/client.ts:235-241`), and its layer rolls back automatically. Two tiny server changes, one new client module, zero changes to the reactivity engine. Offline is a **later, separate feature** this design deliberately does not foreclose.

This is the only candidate design that is (a) production-proven against a protocol isomorphic to ours, (b) shippable in one slice, and (c) consistent with what every team with real scar tissue in this space chose.

---

## 1. Why this fork of the design space

### 1.1 It is proven against *our exact protocol shape*

Convex's client-side layer runs over a wire contract of version-bracketed `Transition`s plus requestId-correlated `MutationResponse`s (e1 §2.2–2.3, [convex-js `optimistic_updates_impl.ts`](https://github.com/get-convex/convex-js/blob/main/src/browser/sync/optimistic_updates_impl.ts), [`request_manager.ts`](https://github.com/get-convex/convex-js/blob/main/src/browser/sync/request_manager.ts)). Our protocol is the same contract minus **one field**: `MutationResponse` lacks the commit ts (`packages/sync/src/protocol.ts:59-60`), which the server already holds in a local variable at the exact send site (`packages/sync/src/handler.ts:209-210`, produced at `packages/runtime-embedded/src/runtime.ts:427` for both local and forwarded-sharded commits). Every other signal the algorithm needs is already on the wire:

- `Transition.endVersion.ts = commitTs` of the invalidating write (`handler.ts:273`) — the drop-gate's clock.
- The origin session is included in its own fan-out (`excludeOriginFromTransition` exists at `handler.ts:253` but is never enabled — `runtime.ts:459`), so the mutating client observes its own write through a normal `Transition`. This is the Convex-compatible choice, already shipped (e1 H9). Keep it.
- `MutationResponse` is sent before the invalidation drains (`runtime.ts:455-458`), so the client reliably sees response-then-transition — the ordering the ts-gate assumes.

No rival design can make this claim. The Replicache/Zero rebase family requires a client data substrate, a per-client `lastMutationID` contract with atomic-with-effects sequencing and a poison-pill rule, and a pull endpoint that computes **patches since a cookie** — which inverts our push-query-results read model outright (e3 §1.5: "the pull 'patch since cookie' is the part Stackbase does NOT have"). PowerSync's Convex integration measured what bolting a client replica onto a Convex-shaped backend costs: "reworking the read path of an existing app, the biggest piece of migration work," with authorization re-expressed as sync rules (e2 §2.4). That is a different product, not a feature.

### 1.2 It is what the survivors chose

The field's revealed preference is unambiguous (e2 §5.4): *server owns writes; client optimism is an overlay dropped on observed inclusion; nobody merges on the client.* And on the offline half specifically:

- **Zero** — built by the Replicache team, the people with the most offline scar tissue — *deliberately dropped offline writes*: "Zero does not support offline writes… it's not a priority right now" ([zero.rocicorp.dev/docs/offline](https://zero.rocicorp.dev/docs/offline), e3 §2.4). Short-horizon optimism is the 95% product.
- **Electric** built the full local-first stack (CRDTs, finality of local writes, local SQLite) and abandoned it in July 2024 — "wide surface for bugs," "demos well… never actually scales out reliably" ([electric-next](https://electric-sql.com/blog/2024/07/17/electric-next), e2 §1.1). The CRDT inventors chose server-authoritative tentativity — the stance this position takes.
- **convex-js itself has no offline** — in-memory only, no disk persistence (e1 §2.4). Offline-first is beyond-Convex territory; parity does not require it.

Shipping offline in the same slice as optimism means shipping, simultaneously: server-side requestId idempotency (there is **no dedup today** — `handler.ts:204-217` just runs the mutation; blind resend double-applies, e1 §1.2), which interacts with the sharded write path (forwarded mutations, `runtime.ts:409-428`); a durable outbox with a poison-queue policy that PowerSync documents as an unavoidable per-app product decision (block/dead-letter/discard, e2 §2.3); temp-id remapping against our server-generated ids (PowerSync×Convex's "most visible DX cost," e2 §2.4); and reconnect/session-resumption, which doesn't exist at any layer (no transport reconnect — `packages/client/src/transport.ts:55-60`; no client `Connect`; server sessions are per-socket, `packages/cli/src/server.ts:280`). That is three slices pretending to be one.

### 1.3 The "drift hazard" is real but bounded — and the alternative's cost is unbounded

E3 Fork 2 is honest: layered updates mean the developer hand-writes a second, parallel guess of each mutation's effect. Accept the criticism and bound it:

- **Optimism is opt-in per callsite.** Only latency-sensitive hot paths (send message, toggle todo) need an update function. Everything else keeps today's behavior — which is already reactive push within one round trip.
- **A wrong guess self-heals in exactly one round trip**, atomically, at the moment the authoritative result lands (§3 below). The failure mode of drift is a one-RTT visual blip, not corruption — server state is never touched by the layer.
- **The drift is testable.** `@stackbase/test`'s `createTestStackbase` runs the real engine in-process with reactive `t.subscribe` (e1 §1.6), so a conformance test can assert "optimistic view before commit == authoritative view after commit" per mutation, mechanically catching drift in CI.

The rebase family eliminates drift by shipping mutators to the client — which requires deterministic re-runnable client mutators, a partial-replication story (Zero built an entire streaming query engine, ZQL + CVR + IVM, to solve it — e3 §2.1), and offline reads as a forcing function. We would be building Zero without Zero's team. Gall's law — invoked by Electric against their own v1 (e2 §1.1) — says start with the simple system that works.

---

## 2. API surface

Convex-parity, verbatim ([docs.convex.dev/client/react/optimistic-updates](https://docs.convex.dev/client/react/optimistic-updates), e1 §2.1). React:

```ts
// examples/chat — send a message with zero perceived latency
const sendMessage = useMutation(api.messages.send).withOptimisticUpdate(
  (localStore, args) => {
    const existing = localStore.getQuery(api.messages.list, {
      conversationId: args.conversationId,
    });
    if (existing === undefined) return; // not subscribed/loaded — no-op, server push will cover it
    localStore.setQuery(api.messages.list, { conversationId: args.conversationId }, [
      ...existing,
      {
        _id: crypto.randomUUID() as Id<"messages">, // temp id, replaced atomically on confirm (§4.3)
        _creationTime: Date.now(),
        author: args.author,
        body: args.body,
      },
    ]);
  },
);
// call site unchanged:
await sendMessage({ conversationId, author, body });
```

Core client (framework-agnostic — the layer lives in `StackbaseClient`, so hooks need zero structural changes, e1 §1.3):

```ts
client.mutation(api.messages.send, args, {
  optimisticUpdate: (localStore, args) => { ... },
});
```

`OptimisticLocalStore` (exactly Convex's three methods):

```ts
interface OptimisticLocalStore {
  getQuery<Q>(ref: Q, args: FunctionArgs<Q>): FunctionReturnType<Q> | undefined;
  setQuery<Q>(ref: Q, args: FunctionArgs<Q>, value: FunctionReturnType<Q> | undefined): void;
  getAllQueries<Q>(ref: Q): Array<{ args: FunctionArgs<Q>; value: FunctionReturnType<Q> | undefined }>;
}
```

- `getQuery` reads the **composed** (optimistic) view; returns `undefined` when the query isn't subscribed or hasn't loaded — the update function must handle that as a no-op.
- `getAllQueries` returns every subscribed arg-variant of one query function — needed to patch e.g. every loaded page of a paginated list. Implementation is a prefix scan over `subsByHash` (keys are `path + ":" + JSON.stringify(argsJson)`, `client.ts:63` — the same identity Convex's store keys on, e1 H4).
- Documented constraint, inherited verbatim from Convex: **update functions must not mutate objects in place** ("Mutating objects inside of optimistic updates will corrupt the client's internal state" — the store shares references). Enforced in dev builds by freezing served values (cheap, dev-only).

Query identity note: `useQuery` and the update function hash args identically (`react.tsx:25` and `client.ts:63` both `JSON.stringify(convexToJson(args))`), so there is no key-mismatch class of bug between the hook and the store.

---

## 3. The reconciliation algorithm, against our protocol precisely

State added to `StackbaseClient` (one new module, ~250 LOC):

```ts
// per subscription (extends today's Subscription, client.ts:21-28):
//   serverValue: Value | undefined   — authoritative, written ONLY by applyModifications
//   value:       Value | undefined   — composed view served to listeners (today's single slot becomes this)
// client-wide:
//   pendingUpdates: Array<{
//     mutationId: number;                       // = requestId counter, already client-local (client.ts:109)
//     update: OptimisticUpdateFn;
//     status: "inflight" | { completedTs: number };
//   }>
//   maxObservedTs: number                       // max endVersion.ts over all APPLIED transitions
```

The five events, mapped onto e1's hook points:

**(1) Mutation initiation (H1, `client.ts:108-114`).** Push `{mutationId, update, status: "inflight"}` onto `pendingUpdates`. Run `update` against a `LocalStore` view over the composed values; record which hashes it modified; fire listeners for those subs. Then send the `Mutation` frame as today. (Convex timing sentence, verbatim: "Optimistic updates are run when a mutation is initiated, rerun if the local query results change, and rolled back when a mutation completes." — e1 §2.1.)

**(2) Server ingest — the sole reconcile path (H2, `applyModifications`, `client.ts:197-217`).** On every applied `Transition`:

```
a. maxObservedTs = max(maxObservedTs, endVersion.ts)
b. drop every pendingUpdate with status.completedTs <= maxObservedTs   // ts-gate closes
c. apply modifications to sub.serverValue (QueryUpdated → jsonToConvex; QueryFailed → keep last, fire onError — unchanged)
d. rebuild: for each sub, composed = serverValue; then REPLAY every surviving
   pendingUpdate, in mutationId order, against the composed store
e. fire listeners for every sub whose composed value changed (reference inequality,
   same changed-detection convex-js uses — e1 §2.2)
f. version = endVersion   // unchanged (client.ts:166)
```

Steps (b)–(e) are one synchronous pass: the layer drop and the authoritative result that replaces it land in the **same listener notification**. That simultaneity is the no-flicker guarantee — Convex's `removeCompleted(ts)` contract (e1 §2.3), TanStack DB's txid-matching, PowerSync's write checkpoints: every modern system converged on *drop on observed inclusion, never on API ack* (e2 §5.1). PowerSync documents the ack-only failure verbatim: "the UI to flash or revert."

**(3) `MutationResponse` failure (H5, `client.ts:169-177`).** Remove the update from `pendingUpdates` immediately, rebuild + replay + notify (rollback = stop replaying — no inverse ops exist anywhere), reject the promise. Convex source comment: "We can resolve Mutation failures immediately since they don't have any side effects." (e1 §2.3.)

**(4) `MutationResponse` success carrying `ts` (H5 + H8 — the one wire change).**
- If `maxObservedTs >= ts` (the covering transition already arrived — possible since fan-out is async) **or** the update modified no subscribed queries (nothing rendered, nothing to flicker): drop now, rebuild, resolve.
- Else mark `status = {completedTs: ts}` and wait for step (2b). The promise resolves at drop-time — Convex parity ("the mutation's promise does not resolve yet," e1 §2.3) — which gives `await mutate(); readLocalState()` read-your-own-writes ordering for free. *Flagged behavior change:* today the promise resolves on `MutationResponse`; resolution moves ~one fan-out later (single-digit ms on a live socket). Worth it for the invariant.

**(5) Transport close (H7, `client.ts:235-241`).** Unchanged rejection of all pendings, **plus** drop all layers and rebuild. The client ends in a consistent server-truth state. This is the entire offline story of this slice, and it is today's exact semantics minus the stale optimistic residue.

Interactions with the existing machinery, checked:

- **Cached first delivery (H3, `client.ts:75`)** serves the composed view, not raw `serverValue`.
- **Resync (G1, `client.ts:153-158, 220-233`):** the adopted baseline's modifications flow through step (2) unchanged — rebuild-and-replay is correct over *any* base, which is exactly why replay architectures are robust where snapshot-restore is not. The stale-baseline race G1 is orthogonal and neither worsened nor fixed by this layer.
- **Sharded ts caveat (e1 G6):** the gate compares against `maxObservedTs`, **not** the current `version.ts`, so it stays correct even if per-invalidation `commitTs` values are not globally monotonic across shards on one session's feed. The Transition that actually delivers my write always has `endVersion.ts >= my commitTs` (it *is* that commit's fan-out, `handler.ts:273`, or a later one), so the gate always closes no later than the write becomes visible — the drop can never precede inclusion.
- **`QueryFailed` mid-flight:** last composed value stays (today's semantics, `client.ts:205-213`); surviving updates keep replaying over the last-known server value. Degraded but consistent.

## 3.1 The G4 answer (the one genuine protocol decision)

E1 G4: only sessions with affected subscriptions get Transitions (`handler.ts:259-261`), so a ts-gate could wait forever when a mutation invalidates nothing the origin reads. Two composing answers, both in this slice:

1. **Client-side (no server change):** if the update modified no subscribed queries, drop on `MutationResponse` (rule 4 above). Covers the common case.
2. **Server-side (~6 lines):** in `doNotifyWrites` (`handler.ts:247-277`), if `originSessionId` is set and absent from `bySession`, send it an **empty ts-advancing Transition** `{startVersion: session.version, endVersion: {querySet, ts: commitTs}, modifications: []}`. This guarantees the gate closes even in the residual case — the update patched a subscribed query but the write's range didn't intersect that session's read set (a wrong optimistic guess against range-precise invalidation). Without it, a wrong guess could stick indefinitely; with it, the bound is one fan-out.

Both are origin-scoped; no other session's traffic changes. (Whether Convex's backend does (2) is unverified — e1 flags it — but our range-precise invalidation makes the residual case reachable, so we close it explicitly rather than by hope.)

---

## 4. Stacking, rollback, temp ids

### 4.1 Stacking — replay-in-order is the *correct* answer to e4 #6

Two in-flight mutations A then B: B's update ran over composed state including A's effect at initiation, but on every ingest the store is rebuilt from the server base and A, B are **re-run in order against it**. When A fails or is dropped, B is recomputed over a base without A — no baked-in double count. This is precisely the fix for Relay's documented compounding pitfall ("optimistic update B computed over optimistic state A bakes A's effect into B's layer"; Relay's own advice is re-run updaters — e4 §3), and it is what convex-js verifiably does (`ingestQueryResultsFromServer`: `new Map(serverQueryResults)`, then replay — e1 §2.2). Apollo's open flash-back bugs (#7341) live exactly in the re-application step this algorithm makes total and unconditional.

Corollary (documented to users, as Replicache does — e3 §1.2): update functions must be cheap, pure, and deterministic over whatever state they find — they run on every ingest.

### 4.2 Rollback — by construction

No undo code exists. Failure → remove from the pending array → next rebuild has no trace. Because there is exactly **one** store and the rebuild recomputes every subscribed query's composed view in one pass, rollback provably covers every projection of the write — there is no "second cache location" to miss (e4 #3's first failure arm is structurally impossible).

### 4.3 Temp ids — Convex's plant-and-replace, with an atomicity proof

The developer plants a client-generated id (`crypto.randomUUID()` string) in the optimistic document. On confirm, step (2) drops the layer **in the same synchronous pass** that ingests the Transition carrying the authoritative row. Why there is never a duplicate-visible frame (e4 #4): any Transition containing my write is the fan-out of a commit with `commitTs >= myTs`, hence `endVersion.ts >= myTs`, hence the gate (2b) fires before listeners do (2e). The temp item and the real item cannot coexist in any notified view.

Honest costs, stated plainly:
- The temp `_id` is not the real id. UI keyed on `_id` sees a key change at confirm (React remount of that row). Mainstream-standard (Convex has the identical property); apps that care key on a client-supplied field.
- A temp id must not be *sent to the server* or stored for later navigation — it is display-only. Documented; the type system can't fully enforce it (Convex can't either).
- Server-computed fields (`_creationTime`, anything the mutation derives) are guesses that visibly correct at confirm if wrong — e4 #2, inherent to optimism over arbitrary server mutations (Firestore's `hasPendingWrites` double-fire is the honest ancestor). Bounded to one RTT; docs show the `Date.now()` guess pattern.

---

## 5. Failure UX

- **Mutation rejected (server threw / OCC gave up / validation failed):** layer drops + listeners fire with reverted state + the mutation promise rejects, all in the same tick. App shows a toast/retry from the rejection. This is the mainstream bar exactly (e4 #9: "silent automatic revert + app-supplied toast" — Apollo, Relay, SWR, TanStack all ship this and nothing more).
- **Transport drop with mutations in flight:** promises reject with `"connection closed"`, layers drop, state reverts to server truth (§3 event 5). The outcome is genuinely ambiguous (the mutation may have committed — e4 #7) and the client **does not retry automatically** — automatic resend without server-side idempotency keys is the double-apply trap (`handler.ts:204-217` has no dedup), so retry is an explicit user action on app-surfaced UI. This is convex-js's own ceiling too (its reconnect reissue depends on server session state we don't have — e1 §2.4).
- **Online-only keeps rollback benign:** the revert window is seconds, not the hours-later ghost-vanish of a durable outbox (Redux-Offline's documented worst case, e4 §5; PowerSync: "the user who made the write may be gone by the time it fails," e2 §2.3). Choosing online-only is choosing the *good* failure UX.
- **Exceeding the bar in userland:** apps wanting a visible failed-state (not a silent revert) can render pending/failed affordances off the mutation promise + a variables-style pattern — nothing in the layer blocks it.

---

## 6. What ships in ONE slice vs deferred

**In the slice:**

1. **Wire:** `MutationResponse` success variant gains `ts: number` (`protocol.ts:59`; populated at `handler.ts:210` from the `commitTs` already destructured on the previous line). One field. Old clients ignore it — backward compatible.
2. **Server:** the G4 empty ts-advancing Transition to origin (~6 lines in `doNotifyWrites`). Nothing else. `excludeOriginFromTransition` stays off (assert this in a test — it is a one-flag foot-gun that silently breaks the gate, e2 §5.1 caveat).
3. **Client:** the optimistic store module in `StackbaseClient` (composed vs server values, pending array, ts-gate, rebuild-replay-notify); `OptimisticLocalStore`; options param on `client.mutation`; `.withOptimisticUpdate` on `useMutation`'s returned callback (`react.tsx:46-52`). `useQuery`/`subscribe` observable behavior unchanged for apps that never opt in.
4. **Tests:** conformance suite via `@stackbase/test` against the real engine — apply/confirm no-flicker (listener never observes a revert frame), failure rollback, two stacked mutations with A failing (the Relay double-count case), temp-id atomic swap, wrong-guess self-heal via the G4 empty transition, resync-with-pending-layers, transport-close cleanup. Reference-scale: convex-js's whole layer is one file + a request manager; ours lands ~250–350 LOC + tests.

**Explicitly deferred (each a separate slice with its own server work):**

- **Reconnect + session resumption** (G2/G3): transport backoff, client-generated stable sessionId in `Connect`, `maxObservedTimestamp` fast-path. Pure additive later; the layer's `maxObservedTs` is exactly the value that slice will send.
- **Offline outbox** (G5): requires server requestId idempotency (interacting with the sharded/fleet write path), a durable intent queue, and a poison-queue policy. The Linear-style durable *outbox of mutations* is the smallest credible upgrade (e3 §5), and it layers on this design without inverting anything: the pending array is precisely what an outbox persists, and the ts-gate is unchanged. This position is the on-ramp to offline, not a dead end.
- **Paginated-list convenience helpers** (`getAllQueries` ships; sugar for insert-into-page can follow user demand).
- **Optimistic actions:** never — actions are non-transactional side effects with no commitTs to gate on.

---

## 7. Checked against e4's failure-mode catalog, number by number

1. **Refetch/invalidation revert-flicker** — *structurally absent.* There is no refetch anywhere: the subscription stream is the sole reconcile path (the Firebase property e4 itself calls out as avoiding the class entirely), and unrelated Transitions rebuild-and-replay surviving layers, so mutation A settling can never visually revert in-flight B. TanStack's canonical bug cannot be expressed in this architecture.
2. **Echo mismatch** — inherent to optimism over arbitrary server code; bounded to one atomic swap at confirm (§4.3); docs state what's guessable (`_creationTime`, ids) and the swap is a single notification, never a revert-then-fix.
3. **Ghost entries** — failure drops the layer from the single store in one pass covering every subscribed projection (§4.2); online-only means no minutes-later outbox vanish.
4. **Temp-id duplicate-on-confirm** — impossible-by-construction: drop and authoritative ingest share one synchronous pass; proof in §4.3.
5. **Double-apply via independent feed** — the ts-gate *is* matching-by-mutation-identity against the one authoritative feed; the base is replaced wholesale before replay, so a layer is never applied on top of its own echo (drop fires in the same pass the echo arrives, 2b before 2d).
6. **Non-independent stacking** — replay-in-order over a fresh base recomputes every survivor after any drop; Relay's counter double-count cannot occur (§4.1).
7. **Ambiguous failure / retry idempotency** — no automatic retry, ever, because the server has no dedup; rejection + revert + app-driven retry. Honest ceiling of online-only; the idempotency-key work is exactly what the offline slice buys later.
8. **Offline-queue ordering / temp-id dependency rewrite** — N/A by deliberate scope; the design's pending array and intent-shaped mutations are forward-compatible with the outbox that will need this.
9. **Failure UX** — meets the mainstream bar (silent revert + rejected promise for the app's toast); visible-failed-state achievable in userland.
10. **Cross-view consistency** — store-level, not per-component: the layer lives in `StackbaseClient`, every subscriber of every patched query sees the composed view, `getAllQueries` covers arg-variants. Unpatched queries degrade gracefully to today's behavior (update on server push — never wrong, merely one RTT later). Yes, the developer chooses which queries to patch — that is Fork 2's known cost (§1.3), bounded, opt-in, and self-healing.

---

## 8. Anticipated attacks, answered

- **"Hand-written updates drift from mutations"** — bounded, opt-in, one-RTT self-healing, CI-testable against the real engine (§1.3). The zero-drift alternative costs a client replica + partial replication + client-shipped mutators; Zero's team, having built both, still chose to cut offline and Electric abandoned the replica outright.
- **"Online-only is a toy"** — it is Convex's shipped product, Zero's shipped product (≤1 min connecting-window aside), and Linear's in-memory speculative tier. The offline outbox is a real later slice with real server prerequisites (idempotency, poison policy); pretending it's free is how Electric v1 happened.
- **"Promise-resolution timing change breaks apps"** — flagged (§3 event 4); the new timing is strictly more useful (await = write visible locally) and single-digit ms later on a live socket; a compat option can resolve-at-response if review demands it.
- **"The scalar ts breaks under sharding"** — the gate uses `maxObservedTs` with a proof that drop never precedes inclusion (§3); the design does not assume the scalar stays a global frontier (e1 G6 heeded).
- **"Why not variables-mode / useOptimistic, even cheaper?"** — component-scoped optimism is e4's documented inconsistency trap (#10) and Electric's own Pattern-2 warning ("other components may display inconsistent information," e2 §1.2). The store-level layer costs barely more and is the difference between a demo and a primitive.

**Bottom line:** one wire field the server already computes, six server lines to close G4, one ~300-LOC client module implementing an algorithm with years of production verification on an isomorphic protocol — and Stackbase gets flicker-free optimistic UX that Supabase officially has no answer to (e4 §7), without betting the client architecture on the offline problem that the best-resourced teams in the field either cut or retreated from.
