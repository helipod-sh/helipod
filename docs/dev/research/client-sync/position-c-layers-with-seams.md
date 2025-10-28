# Position C — Layers now, log-ready seams

**Claim:** Ship Convex-parity optimistic-update layers as the v1 API — and build them out of the three components a future offline queue needs anyway (a pending-mutation log, a base-vs-composed layered query store, a single reconciliation chokepoint), with those seams named, typed, and tested from day one. Add the one durable-retry win that is nearly free once those seams exist: transport reconnect with an in-memory outbox of **never-sent** mutations that survives a dropped socket (not a page reload). Two server changes, both protocol-completions in `packages/sync`, both needed by every rival design.

The one-sentence case against the rivals: **the correct implementation of Position A's "just Convex parity" already contains Position C's seams — A only saves anything by cutting the corners that produce Apollo's open concurrency bugs; and Position B's durable offline queue is the feature that Zero's team (maximum scar tissue) deliberately dropped, that Electric abandoned a funded company-year on, and that requires a server-side idempotency subsystem colliding with our in-flight fleet/sharding work.** C is not a compromise between A and B; it is the point both of them converge to when you subtract A's future rewrite and B's premature server contract.

All code claims below are file:line against branch `scheduler-component`; web claims cite the evidence docs (e1–e4 in this directory) which carry the primary URLs.

---

## 1. Why layers are the right v1 model (not a consolation prize)

Four facts, each independently sufficient:

1. **The protocol is one field away.** Our `Transition.endVersion.ts` already carries the commit timestamp of the invalidating write (`packages/sync/src/handler.ts:273`), the executor already returns `commitTs` for every mutation (`handler.ts:47`, produced `packages/runtime-embedded/src/runtime.ts:427`), and the origin session already receives its own write's Transition (`excludeOriginFromTransition` exists at `handler.ts:63,253` but is never enabled — e1 §1.5). The only missing piece of the entire Convex reconciliation contract is that `MutationResponse` discards the `commitTs` it holds at the send site (`handler.ts:209-210`, wire type `protocol.ts:59-60`). No other design in this corpus starts this close to done.

2. **The layered model is the convergent industry mechanism, not a Convex quirk.** Electric Pattern 3's `write_id` round-trip, TanStack DB's txid-matching, PowerSync's write checkpoints, and Convex's ts-gate are the same primitive: *pending writes live in an ephemeral overlay atop immutable synced state, dropped only when the client observes a marker in the authoritative read stream proving inclusion* (e2 §5.1). We get the marker for free on our own wire — no marker rows, no idle-cursor bug (the failure class PowerSync's Convex integration hit, e2 §2.4).

3. **The alternatives' owners retreated from the alternatives.** Electric built the full local-first stack (client SQLite, CRDTs, finality-of-local-writes) and froze it in July 2024 — "wide surface for bugs," "demos well… never actually scales out reliably" (e2 §1.1). Zero — built by the Replicache team, the people who shipped the best rebase-substrate design — deliberately does not support offline writes: "not a priority right now" (e3 §2.4). PowerSync's Convex integration found the biggest cost of bolting a client replica onto a Convex-shaped backend was **rewriting the read path and re-expressing authorization as sync rules** (e2 §2.4) — our reads are server-executed TypeScript with server-side authz; a replica substrate is a different product.

4. **Parity is the actual product bar.** Convex — the DX benchmark this project exists to match — ships layered `withOptimisticUpdate` and no offline (convex-js has reconnect but zero disk persistence, e1 §2.4). Supabase ships nothing at all (e4 §7). Layers put us at Convex parity and past Supabase; offline-first is beyond-parity territory that deserves its own researched slice, the same way scheduler/workflow/storage each got one.

## 2. The core architectural claim: correct layers ARE the log-ready components

Look at what convex-js itself keeps (e1 §2.2): `queryResults` (a server-snapshot map, replaced wholesale on ingest) **plus an ordered array of `{update, mutationId}` pending records**, replayed in order over every new snapshot. That ordered array of pending mutation records *is* a mutation log. The Replicache lineage makes the same point from the other direction: its whole reconciliation is "rewind to server state, replay the pending mutation log in order" (e3 §1.1), and Linear's offline story is exactly "a durable outbox of *intentions* (not data), replayed into memory on restart" (e3 §4.3).

So the fork between "online optimistic layers" and "offline outbox" is **not an architectural fork at the client's core** — both need:

- an **ordered pending-mutation log** whose entries carry `(requestId, udfPath, args)` — the serializable triple;
- a **layered store** that keeps immutable server results separate from a composed view;
- a **single reconciliation chokepoint** where base updates, layer drops, and replays happen atomically.

The offline slice later changes *the log's backing store* (memory → IndexedDB), *the delivery policy* (reject-on-disconnect → park-and-resend), and *adds a server idempotency contract*. It does not change the reconciliation algorithm. Position A, implemented correctly, builds these same three things but leaves them anonymous and entangled (pending state inside the promise map at `client.ts:36`, composed and base values sharing the one `sub.value` slot at `client.ts:26`, drop logic inline in `onServerMessage`) — and then the offline slice is a rewrite of the client's hot core instead of two adapter swaps. Position B builds all of C plus a durable store, a resend protocol, server idempotency keys, and a rejection-UX product decision — now, without demand signal, against the counsel of everyone who has shipped it.

## 3. API surface (exact)

Convex-parity, because our users arrive knowing it and `stackbase migrate` is a codemod:

```ts
// React (packages/client/src/react.tsx — useMutation gains .withOptimisticUpdate)
const send = useMutation(api.messages.send).withOptimisticUpdate(
  (localStore, args) => {
    const list = localStore.getQuery(api.messages.list, { channel: args.channel });
    if (list !== undefined) {
      localStore.setQuery(api.messages.list, { channel: args.channel }, [
        ...list,
        {
          _id: crypto.randomUUID() as Id<"messages">, // temp id; replaced atomically on confirm (§6)
          _creationTime: Date.now(),
          body: args.body,
          author: me,
        },
      ]);
    }
  },
);
await send({ channel, body });
```

```ts
// Core client (framework-agnostic)
await client.mutation(api.messages.send, { channel, body }, { optimisticUpdate });

// The store handed to update functions (Convex-parity names):
interface OptimisticLocalStore {
  getQuery(ref: FunctionReference | string, args?: Record<string, Value>): Value | undefined;
  setQuery(ref: FunctionReference | string, args: Record<string, Value>, value: Value | undefined): void;
  getAllQueries(ref: FunctionReference | string): Array<{ args: Value; value: Value | undefined }>;
}
```

`getQuery` returns `undefined` for unsubscribed/unloaded queries (updates are best-effort over what's locally visible — e1 §2.1). Query identity is our existing hash `path + ":" + JSON.stringify(argsJson)` (`client.ts:63`, hook H4) — the same token Convex keys on. Update functions must be pure over the store (no in-place mutation of returned objects); in dev mode we `Object.freeze` values handed out by `getQuery`, turning Convex's documented "will corrupt the client's internal state" footgun (e1 §2.1) into an immediate throw — a small beyond-parity DX win that costs ~5 lines.

Hooks need nothing else: if the layer lives inside `StackbaseClient` (composing before listeners fire), `useQuery` (`react.tsx:29-43`) re-renders unchanged, and the initial cached delivery at `client.ts:75` (H3) serves the composed view.

## 4. The three seams, named

These are the components; the names are the contract with the future offline slice.

**S1 — `MutationLog` (the pending-mutation registry).** The component B needs durable and A leaves implicit.

```ts
interface PendingMutation {
  requestId: string;
  udfPath: string;
  args: JSONValue;                       // stored as JSON — the (requestId, udfPath, args) triple is
                                         // serializable BY CONSTRUCTION; the future durable log
                                         // persists exactly this (Linear's __transactions shape, e3 §4.3)
  update?: OptimisticUpdateFn;           // looked up at replay, never serialized (see §10 note on
                                         // statically-registered updaters for reload replay)
  status:
    | { type: "unsent" }                 // queued, never hit the wire — safe to (re)send
    | { type: "inflight" }               // sent, no response — outcome unknowable on disconnect
    | { type: "completed"; commitTs: number }; // acked; layer held until ts-gate (§5)
}

interface MutationLog {
  append(m: PendingMutation): void;
  markInflight(requestId: string): void;
  markCompleted(requestId: string, commitTs: number): void;
  drop(requestId: string): void;         // failure, or ts-gate satisfied
  pendingInOrder(): readonly PendingMutation[];
  unsentInOrder(): readonly PendingMutation[];
}
```

v1 backing: an array. Offline backing: IndexedDB. The reconciliation code never knows which.

**S2 — `LayeredQueryStore` (base vs composed).** Splits today's single `sub.value` slot (`client.ts:26`) into `serverValue` (written only by server ingest) and `composedValue` (= replay of `pendingInOrder()`'s updates over the base; what listeners and the H3 cached delivery see). Change detection by reference inequality, as convex-js does (e1 §2.2).

**S3 — the reconcile chokepoint.** One function through which every state change flows — server Transition (H2, `applyModifications` at `client.ts:197-217` is today's sole ingest point, which is why this refactor is small), mutation initiation (H1), mutation resolution (H5), transport events (H7):

```ts
// The ONLY place layers are applied, dropped, or replayed.
reconcile(event:
  | { type: "serverIngest"; mods: StateModification[]; endVersion: StateVersion }
  | { type: "mutationApplied"; m: PendingMutation }
  | { type: "mutationCompleted"; requestId: string; commitTs: number }
  | { type: "mutationFailed"; requestId: string }
  | { type: "connectionRestored" }       // resubscribe + flush unsent (§7)
): void
```

This is the discipline every survey system converged on: Firebase's subscription-stream-as-reconcile-path (e4 §6, the family with no refetch race), TanStack DB's rebase-on-synced-change (e2 §1.3), convex-js's `ingestQueryResultsFromServer` (e1 §2.2). Apollo's open bugs (#7341 flash-back, e4 §2) live precisely in scattered re-application code — the chokepoint is the countermeasure.

A fourth, smaller seam: **S4 — `DeliveryPolicy`**, the routing of transport events into log transitions. v1 policy: `unsent` survives disconnect and flushes on reconnect; `inflight` rejects (outcome unknowable — G5, e1 §3). The offline slice replaces this policy object with park-and-resend once server idempotency exists. Today's `onTransportClosed` (`client.ts:235-241`) becomes the trivial case of this seam.

## 5. The reconciliation algorithm, precisely, against our protocol

State: `MutationLog` + per-subscription `{serverValue, composedValue}` + `this.version` (H6, `client.ts:32`).

1. **Mutation initiation (H1, `client.ts:108-114`).** Assign `requestId`; run `update(localStoreView, args)` where the store view reads current *composed* state and its writes stack on top (incremental application ≡ full replay, matching convex-js). If the updater throws, throw synchronously at the call site and send nothing. Append to the log (`unsent`); if the socket is open, send `Mutation` and `markInflight`. Fire listeners for modified queries only.

2. **Transition, contiguous (`client.ts:161-166`).** Atomically, in one `reconcile` call: (a) compute `dropIds` = every `completed` entry with `commitTs <= msg.endVersion.ts` — this is exactly convex-js's `removeCompleted(ts)` gate, `status.ts.lessThanOrEqual(ts)` (e1 §2.3); (b) apply `modifications` to `serverValue`s; (c) drop `dropIds` from the log; (d) recompute every touched subscription's `composedValue` = replay surviving updates in order over the new base; (e) fire listeners where the composed value changed; (f) `version = endVersion`. Step (a)+(b) landing in the same recompute **is** the no-flicker guarantee: speculative state is replaced by the authoritative state that includes the write, never by a pre-write snapshot (e1 §2.3; PowerSync documents the flash-backward failure of dropping on ack alone, e2 §2.2).

3. **`MutationResponse` success (H5, `client.ts:169-177`), now carrying `ts`.** `markCompleted(requestId, ts)`; resolve the promise. Drop immediately (skip the gate) iff the entry has no update or its update modified zero locally-subscribed queries — nothing to hold, and this also handles a mutation that invalidates nothing anyone reads. Server ordering guarantees the response precedes the transition (`runtime.ts:455-458`; e1 §1.5), so the gate is armed before it can fire. If `this.version.ts >= ts` already (possible after a resync baseline adoption), drop now.

4. **`MutationResponse` failure.** `drop(requestId)`; recompute composed; reject the promise. Rollback is "stop replaying" — no inverse ops exist to get wrong (e1 §2.4, e3 §1.1).

5. **Version gap → `resync()` (`client.ts:161-164, 220-233`).** Unchanged, and the layer is agnostic to it: whatever baseline is adopted becomes the new base; surviving updates replay over it. Note honestly: the G1 stale-baseline race (e1 §3) predates this design and reconnect will exercise resync more often — G1 should be hardened in the same slice (tag the re-subscribe response, or serialize `handleModifyQuerySet` with the notify tail server-side), but it is orthogonal to the layer.

6. **Transport close/restore (H7 → S4).** §7.

**The one genuine protocol decision — G4 (e1 §3).** Only sessions with affected subscriptions receive Transitions (`handler.ts:259-276`), so a session's `version.ts` can sit behind the frontier forever, and a `completed` layer whose update patched query Q — where the server write does *not* actually invalidate Q (a wrong optimistic guess) — would never be gated out. Step 3's drop-on-no-local-queries rule does not cover that case. The fix is server change #2: in `doNotifyWrites`, if `originSessionId` is present but absent from `bySession`, send it an empty ts-advancing Transition `{startVersion: session.version, endVersion: {querySet, ts: commitTs}, modifications: []}` (~6 lines after `handler.ts:257`; monotone because commits and the notify tail are serialized, `handler.ts:241-245`). If the origin's subs *are* partially affected, the normal Transition's `endVersion.ts = commitTs` (`handler.ts:273`) satisfies the gate and Q correctly reverts to server truth — the updater guessed wrong; reverting is the right answer. The pure-client alternative ("drop when all update-modified queries have received a QueryUpdated") is a heuristic that is wrong under partial overlap; the empty transition closes the whole class and additionally gives the origin monotone read-your-write versioning that a future `maxObservedTimestamp` resume (e1 §2.4) wants anyway.

Do **not** enable `excludeOriginFromTransition` (H9): the ts-gate consumes the origin's own fan-out. Our shipped behavior is already the Convex-compatible one (e1 §1.5); this is a zero-line "change."

## 6. Stacking, rollback, temp ids

**Stacking** (e4 #6): the log is ordered; every ingest replays *all* surviving updates over the fresh base. An update computed over optimistic state below it is recomputed when that state changes — the Relay counter-double-count (layer discard leaving a baked-in copy of a rolled-back layer's effect, e4 §3) cannot occur, because we never discard one layer while keeping stale compositions of it; we recompute. This is the behavior Relay documents as correct and Apollo's re-application step fails to deliver (#7341).

**Rollback**: by construction — a dropped log entry simply stops being replayed; the next recompute is server truth plus survivors. No snapshot-restore (so no TanStack erase-sibling bug, e4 §1), no app-authored inverse reducers (no Redux-Offline hand-written undo, e4 §5).

**Temp ids**: Convex's plant-and-replace. The developer mints a client id (`crypto.randomUUID()`) inside the update; because the layer is dropped in the same recompute that ingests the authoritative rows (§5 step 2), the temp item is *replaced*, never duplicated — there is no update function that runs twice against the real response (the Apollo #1100 duplicate source, e4 §2). Two documented constraints: (a) temp ids must never be passed as mutation args or persisted — they exist only inside the overlay; (b) a temp id will not survive a round-trip into a real `Id<"...">`-validated mutation. Create-then-edit against a not-yet-confirmed doc is therefore out of scope for v1 optimism (the app awaits the create's promise first) — the rebase-family answer (client-generated *real* ids as args, e3 §1.3) requires client-supplied ids in the insert path, a server change we defer to the offline slice where it is actually load-bearing (PowerSync×Convex called this remapping their "most visible DX cost," e2 §2.4 — a cost we do not pay until we buy the feature that needs it).

## 7. The nearly-free durable-retry win: reconnect + the unsent outbox

Today a dropped socket is terminal — `transport.ts:55-60`, no retry anywhere (G2), and `onTransportClosed` rejects *every* pending mutation even ones still sitting in the pre-OPEN queue (`client.ts:235-241`). Once S1/S4 exist, the following is ~150 lines and no server changes:

- **`reconnectingWebSocketTransport`**: wraps the existing transport; exponential backoff; `onClose` becomes non-terminal, a new `onReconnect` fires when the socket reopens.
- **On reconnect**: re-send `SetAuth` (remember the last token — a field), then the existing `resync()` path re-subscribes every live query with its existing queryIds (`client.ts:228-232` already does exactly this; the server session is fresh, so the subscription adds are clean), then flush `unsentInOrder()` FIFO.
- **Policy line, drawn hard**: `unsent` mutations survive and resend — safe by construction, they never reached the wire. `inflight` mutations still reject with a distinct `MutationUndeliveredError("outcome unknown")` — the server has no requestId dedup (`handler.ts:204-217` just runs the mutation), so blind resend risks double-apply (G5/e4 #7), and the idempotency-key server contract belongs to the offline slice (it also interacts with the forwarded-mutation fleet path, `runtime.ts:409-428` — not a corner to cut in a client slice).

This is Zero's exact scope decision — reconnect-window queuing yes, durable offline no (e3 §2.4) — and it is what makes the seams *proven* rather than speculative: S1's status machine, S4's policy, and the flush path are exercised by real tests in v1, so the offline slice later swaps backings instead of designing interfaces cold. Layers stay pinned while the log is non-empty in the sense that matters (they replay over every base until gated) — the translation of PowerSync's no-advance-while-queue-nonempty rule into a system whose replay unit is a named mutation (e2 §5.2).

Explicitly *not* in v1: persistence across reload (needs auth-token persistence + updaters replayable from `udfPath` — see §10), resend of `inflight` (needs server idempotency), any UI queue affordance beyond promise rejection.

## 8. Failure UX

Mainstream bar, met exactly (e4 #9): failure → layer dropped in the same reconcile, promise rejects, app shows its toast; the revert is automatic and provably total (§6). Updater-throw fails fast at the call site before anything hits the wire. Disconnect-with-inflight rejects with a *typed* ambiguity error (`MutationUndeliveredError`) so apps can distinguish "server said no" from "unknown outcome" — SWR's error-dependent rollback insight (e4 §4) surfaced as a type instead of an option. Cheap beyond-bar addition the registry makes free: a read-only `client.pendingMutations()` accessor (count + statuses) so apps can render a "saving…" affordance — Zero's `.client`/`.server` two-promise DX (e3 §2.2) noted as a possible follow-on, not v1.

## 9. Server changes: exactly two, both in `packages/sync`, both universal

1. **`MutationResponse.ts`** — add the commit timestamp the handler already holds (`protocol.ts:59` + `handler.ts:210`; value produced at `runtime.ts:427`). One field. This is H8, and it is the write-checkpoint/txid primitive every surveyed system had to build out-of-band (e2 §5.1); we get it on-response, immune to PowerSync's idle-cursor failure class (e2 §2.4).
2. **Empty ts-advancing Transition to an unaffected origin** (~6 lines in `doNotifyWrites`, §5) — closes G4, the one place a pure-client design can wedge.

That's it. No idempotency keys, no per-client mutation sequencing, no patch-since-cookie pull, no session resumption protocol. For calibration: Position B needs both of these **plus** requestId dedup atomic with commit (Replicache's lmid contract, e3 §1.5, including its poison-pill rule) **plus** the temp-id/client-id insert story — a server slice touching the transactor and the fleet path. Position A needs both of mine too (without #1 there is no ts-gate at all; without #2 it either leaks layers or ships the partial-overlap heuristic bug). Fewer server changes than C is not actually on the table; C just says so out loud.

One forward-looking caveat, flagged honestly: the ts-gate assumes the scalar `version.ts` means "everything ≤ ts is reflected." The write-sharding corpus already notes that meaning breaks under multi-shard feeds (e1 §3 G6). The gate comparison should live behind one small function (`versionCoversCommit(version, commitTs)`) so the sharded-frontier slice changes one predicate, not the reconciler.

## 10. What ships in ONE slice vs deferred

**The slice** (client `packages/client` + the two `packages/sync` changes + conformance tests in `@stackbase/test` — `t.subscribe` runs the real engine, so reconciliation is tested against real commits, not mocks; e1 §1.6):

- S1 `MutationLog` (memory), S2 `LayeredQueryStore`, S3 reconcile chokepoint, S4 `DeliveryPolicy`
- `withOptimisticUpdate` on `useMutation` + `client.mutation(..., { optimisticUpdate })` + `OptimisticLocalStore` (with dev-mode freeze)
- ts-gated drop per §5; `MutationResponse.ts`; empty-transition G4 fix
- `reconnectingWebSocketTransport` + resubscribe + SetAuth replay + unsent-outbox flush
- G1 resync-baseline hardening (small, and reconnect makes it non-hypothetical)
- Docs page with the temp-id and purity constraints stated as rules

**Deferred, with the seam that receives each named:**

| Deferred | Receiving seam | Server prerequisite |
|---|---|---|
| Durable outbox across reload | S1 backing → IndexedDB | requestId idempotency keys, atomic with commit (and fleet-path threading) |
| Resend of `inflight` mutations | S4 policy | same idempotency contract |
| Updaters replayable after reload | register updates statically by `udfPath` (the log's serializable triple is already sufficient to *identify* them) | none |
| `maxObservedTimestamp` fast resume / session resumption | reconnect handshake | `Connect` handler (today a no-op, `handler.ts` per e1 §1.5) |
| Client-supplied ids for offline inserts | update-fn convention + insert path | id-codec acceptance of client ids |
| Pending/failed UI affordances (`useMutationState`-alike) | S1 accessors | none |

Nothing in the deferred column requires reopening §5's algorithm. That is the position.

## 11. Against A and against B, compactly

**A underbuilds the architecture.** The delta between A-done-correctly and C is nearly zero code: convex-js itself keeps the separate server-snapshot map and the ordered pending array (e1 §2.2) — you cannot implement the no-flicker ts-gate *without* a pending registry and a base/composed split. What A saves by not naming the seams is: interfaces, the reconnect/outbox win, the G4 server fix (or it ships the wedge), and tests that pin the seam contracts. What A costs: the offline slice becomes surgery on the client's hot core, re-deriving under pressure the exact boundaries C writes down now — and the survey says the reconcile step is precisely where mature libraries still have open bugs years in (Apollo #7341/#1100, TanStack's canonical revert-flicker needing a maintainer blog post to work around; e4 §1–2). If the marginal cost of the seams were high, A would have a case; it is approximately the cost of writing three interface declarations.

**B overbuilds v1.** Every additional thing B ships past C is on the wrong side of the evidence: durable offline queues are what Zero's team explicitly declined ("no sync engine or CRDT algorithm can automatically solve it for you," e3 §2.4); the rejection UX for hours-old queued writes is a per-app product decision with a poison-queue wedge as the default failure mode (PowerSync's four strategies, e2 §2.3); the server must grow an idempotency/sequencing contract with a poison-pill rule (e3 §1.5) that threads through the sharded/fleet mutation path currently under active construction; and the temp-id remapping cost arrives immediately (e2 §2.4). All of that for a capability Convex doesn't have, no user has asked for, and whose *client-side* half C's seams receive additively when the demand signal arrives. B's best argument — "you'll build the client twice" — is exactly the argument C eliminates.

## 12. The e4 failure-mode catalog, number by number

1. **Refetch/invalidation revert-flicker** — no refetch primitive exists; the subscription stream is the sole reconcile path (Firebase's structural immunity, e4 §6), and drop+ingest are one atomic recompute (§5.2). *Answered by construction.*
2. **Echo mismatch on server-computed fields** — the guess is replaced by the authoritative result in the same paint (ts-gate simultaneity, §5.2); server-computed values (real `_id`, `_creationTime`) snap once, with no intermediate revert-to-old window. Residual honesty: the snap is visible if the guess was wrong; that is inherent to optimism over arbitrary server mutations (e4 §6 cost (a)).
3. **Ghost entries** — rollback is stop-replaying + full recompute, which provably covers every query the updater touched (there is no second cache to miss). No minutes-old queue exists in v1 (the outbox holds only unsent mutations across a reconnect window, seconds).
4. **Temp-id duplicate-on-confirm** — whole-layer atomic drop on the ingest carrying the authoritative rows; no updater ever runs against the real response (§6). *The Apollo #1100 class cannot occur.*
5. **Double-apply via independent change feed** — one feed (`Transition`), one ingest chokepoint (S3), pending matched by `requestId`/`commitTs`, never by value. The Supabase minefield (e4 §7) is structurally absent.
6. **Non-independent stacking** — ordered replay over a fresh base on every ingest (§6); Relay's documented compounding bug is answered by recomputation, not layer algebra.
7. **Ambiguous failure / retry idempotency** — `inflight` at disconnect rejects with a typed unknown-outcome error; only never-sent mutations resend (safe by construction); at-least-once resend is explicitly deferred until server idempotency keys exist (§7). *We refuse the unsafe retry rather than hand-waving it.*
8. **Offline-queue ordering + temp-id dependency rewrite** — v1's outbox is FIFO; the dependency-rewrite problem cannot arise because temp ids are barred from mutation args (§6). The full problem is deferred with the durable queue, where client-supplied real ids (the rebase-family answer, e3 §1.3) are the planned resolution.
9. **Failure UX** — silent automatic revert + promise rejection + app toast (the mainstream bar), plus a typed ambiguity error and a cheap pending-count accessor (§8); visible-failed-state affordances are a named follow-on the registry makes trivial.
10. **Per-query vs store-level overlay** — store-level, inside `StackbaseClient`: every subscriber of every patched query sees the composed view, including the H3 initial cached delivery. Cross-view consistency is bounded by which queries the updater patches — the honest Convex limitation (the update runs over the local query cache, e4 #10) — mitigated by `getAllQueries` for arg-families (pagination) and by documentation, not by pretending a query-result cache is a database.

## 13. Uncertainties, flagged

- The Convex backend's own answer to G4 (empty ts-advancing transitions vs client-side drop) is unverified (e1 §3 flags it); our §5 fix is chosen on our own protocol's merits, not copied.
- The claim that reconnect+resubscribe is ~150 lines assumes the server-session-is-fresh path holds exactly as read from `cli/server.ts` and `handler.ts` (e1 §1.5); a spike should confirm queryId reuse across a new socket before the slice is estimated.
- Dev-mode `Object.freeze` on `getQuery` results has a perf cost on large results; gate it to dev builds and measure.
- The sharded-ts caveat (§9) means the gate predicate is a seam too; if B2b multi-node lands before this slice, revisit `versionCoversCommit` first.
