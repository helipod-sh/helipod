# E4 — Mainstream optimistic-update patterns (web evidence)

Evidence agent E4 for the client-sync research workflow. Question: how do the mainstream
client-data libraries do optimistic updates — rollback mechanism, stacking behavior,
failure UX, and what classically breaks. All claims below are web-sourced (URLs inline);
where a claim is inference rather than documented fact, it is flagged as such.

The libraries fall into **three architectural families**, and the family determines the
failure modes:

| Family | Rollback mechanism | Members |
|---|---|---|
| **Snapshot / manual patch** | copy-old-state-then-restore, or app-authored inverse action | TanStack Query (cache mode), SWR, Redux-Offline |
| **Layered overlay** | optimistic writes live in a discardable layer *above* canonical state; rollback = drop the layer | Apollo, Relay, TanStack Query (variables mode, degenerately) |
| **Local-store echo (latency compensation)** | pending local writes are merged over the synced store; server confirmation *replaces* the pending write in place — there is no separate "rollback" path for success, only for rejection | Firebase RTDB / Firestore (the original) |

Supabase is the notable absence: no story at all (see §7).

---

## 1. TanStack Query (React Query)

**Two documented approaches** ([official guide](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)):

**(a) Cache-write mode** — the classic `onMutate` pattern:
1. `onMutate`: `cancelQueries` (so an in-flight refetch can't overwrite the optimistic
   write), **snapshot** the previous cache value, write the optimistic value, return the
   snapshot as rollback context.
2. `onError`: restore the snapshot.
3. `onSettled`: `invalidateQueries` — refetch the server truth regardless of outcome, as
   "insurance" against a wrong optimistic guess.

Rollback is **snapshot-restore**, not inverse-patch and not a layer discard: you literally
put the old object back. That is exactly why it composes badly under concurrency —
restoring mutation A's snapshot silently erases mutation B's optimistic write if B landed
after A's snapshot was taken.

**(b) Variables mode (the newer approach, and why they moved)** — don't touch the cache
at all. The pending mutation's `variables` (and `isPending`) are read directly in the UI
(via the mutation itself or `useMutationState({ mutationKey })` from any component) and
rendered as extra/temporary items on top of the query result. When the mutation settles,
the temporary item disappears and the invalidated query brings the real row. The docs'
stated rationale: it "requires less code" and is "generally easier to reason about" when
the optimistic result is shown in one place; use cache-writes only when many screens must
see the update. Structurally this is a poor-man's overlay: pending state is a separate
layer *composed at render time*, so there is nothing to roll back — the layer just stops
existing. Concurrent mutations surface as an array of `variables`, keyed by
`mutation.state.submittedAt`.

**Stacking**: nothing automatic in cache mode. The documented footgun
([TkDodo, "Concurrent Optimistic Updates in React Query"](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query)):
mutation 1 settles → `onSettled` fires `invalidateQueries` → the refetch returns server
state that predates mutation 2 (still in flight) → mutation 2's optimistic write is
visually reverted, then snaps forward again when mutation 2 settles. Note `cancelQueries`
does **not** save you here — mutation 2's `onMutate` ran before mutation 1's refetch
started, so there was nothing to cancel. The community fix is to **suppress invalidation
while sibling mutations are in flight**:

```ts
onSettled: () => {
  if (queryClient.isMutating({ mutationKey: ['items'] }) === 1) {
    queryClient.invalidateQueries({ queryKey: ['items'] })
  }
}
```

i.e. only the *last* settling mutation triggers the refetch. That this must be hand-rolled
in userland — and is subtle enough to need a canonical blog post by a maintainer — is the
strongest single argument that snapshot-restore + refetch-on-settle is the wrong core
primitive, and it is the pattern most Stackbase users will arrive knowing.

**Failure UX convention**: `onError` → restore snapshot + toast; `onSettled` →
invalidate. The rollback is abrupt (the item vanishes / value snaps back); the toast is
the only explanation the user gets.

## 2. Apollo Client — `optimisticResponse` on a normalized cache

([official docs](https://www.apollographql.com/docs/react/performance/optimistic-ui))

- The caller supplies a fake mutation response (`optimisticResponse`) shaped like the
  real one, including `__typename` and `id` so the normalized cache can compute the cache
  identifier. For creations you must invent a **temporary ID**.
- **Layering, not overwrite**: the optimistic object "does not overwrite the existing
  cached object with the same cache identifier — it stores a separate, optimistic version."
  Every optimistic mutation gets its own cache layer above the canonical store; reads see
  canonical-plus-layers.
- **On success**: the optimistic layer is removed *and* the canonical entry is
  overwritten with the real server response in one step — if the guess matched, the swap
  is invisible. **On error**: the layer is simply discarded — rollback is automatic and
  needs no app code. This is the cleanest rollback semantics of the group.
- List membership is the escape hatch that ruins it: the normalized cache knows how to
  update *fields of an existing entity* automatically, but inserting a new entity into a
  list requires an imperative `update` function that runs **twice** (once against the
  optimistic layer, once against the real response) — the classic source of duplicates
  (see catalog #4).

**Stacking**: layers stack in mutation order and are removed individually, which is
correct in principle, but there are long-standing concurrency bugs in practice:
optimistic updates "not being re-applied when the server returns a value for one
mutation, causing the UI to flash back to old values" with multiple in-flight mutations
([apollo-client #7341](https://github.com/apollographql/apollo-client/issues/7341)),
temporary duplicate rows under rapid successive mutations on a slow network
([Apollo community thread](https://community.apollographql.com/t/optimistic-mutation-temporary-duplicate-responses/6662)),
and the ancient list-reducer duplicate bug
([#1100](https://github.com/apollographql/apollo-client/issues/1100)). Lesson: even with
architecturally-correct layering, the *re-application/reconcile step* is where the bugs
live.

**Failure UX**: silent automatic revert; surfacing the error (toast, retry affordance) is
entirely on the app. `optimisticResponse` can conditionally return an `IGNORE` sentinel
to skip optimism per-call.

## 3. Relay — optimistic updater + declarative directives

([Relay guided tour: mutations](https://relay.dev/docs/guided-tour/updating-data/graphql-mutations/))

- Two knobs: `optimisticResponse` (declarative payload written into the store) and
  `optimisticUpdater` (imperative function with full store access, for connection/list
  edits). Declarative directives (`@deleteRecord`, `@appendEdge`/`@appendNode`,
  `@deleteEdge`) let the *mutation document itself* declare list membership changes, so
  the common cases need no imperative code — applied for both the optimistic and the real
  response, symmetrically.
- **Rollback is layer-based** like Apollo: when the server response arrives, the
  optimistic state for that mutation is rolled back *first*, then the server data is
  committed and the (non-optimistic) updater/directives run; on error the optimistic
  update reverts immediately.
- **The documented pitfall is compounding**: Relay's own docs warn optimistic responses
  have "many pitfalls" — e.g. two in-flight optimistic mutations that each read-modify-write
  a counter: the second's updater ran against a store that already included the first's
  +1, so its layer bakes in the first's effect; roll back the first and the total is
  still wrong (double-count). Layer discard is only sound when layers are
  **independent**; any optimistic update *derived from optimistic state below it* breaks
  the algebra. Relay's advice is to prefer `optimisticUpdater` when the new value depends
  on current store values — the updater is at least re-run on reconcile.

**Failure UX**: same as Apollo — automatic silent revert, app-provided error surface.

## 4. SWR — `mutate(key, fn, { optimisticData, rollbackOnError })`

([SWR mutation docs](https://swr.vercel.app/docs/mutation))

- `optimisticData` (value or `current => next` function) writes the cache immediately;
  `rollbackOnError` restores the pre-mutation snapshot on failure — snapshot-restore, same
  family as TanStack cache mode, but packaged as options instead of hand-written
  callbacks. `rollbackOnError` can be a function of the error ("if it's a timeout abort,
  don't roll back") — a small but notable refinement: **rollback policy is
  error-dependent**, since an aborted request may still have committed server-side.
- `populateCache` writes the mutation's *return value* into the cache (skip the refetch);
  `revalidate` (default true) refetches after the mutation resolves. `throwOnError`
  (default true) makes the `mutate` call itself throw for try/catch UX.
- **Stacking**: nothing like layering; concurrent `mutate`s on one key are
  last-writer-wins on a single cache slot, and the snapshot captured by a later mutate
  may itself be optimistic (rollback then restores another mutation's guess — inference
  from the snapshot model, not documented). SWR's documented race protection is narrower:
  `useSWRMutation` tells a concurrent `useSWR` revalidation to discard its in-flight
  result so a stale fetch can't overwrite the mutation's outcome.

**Failure UX**: rollback + thrown error → app shows a toast. Same abrupt-revert
convention as everyone else.

## 5. Redux-Offline — the offline-first queue archetype

([redux-offline README](https://github.com/redux-offline/redux-offline))

- An action carries `meta.offline: { effect, commit, rollback }`. The action's own
  reducer applies the **optimistic state change immediately**; the `effect` (network
  call) goes into a persisted **outbox queue**, processed **serially, FIFO**, with retry
  + backoff, **at-least-once** — the queue survives app restarts.
- **Rollback is app-authored inverse handling**: on permanent failure the library
  dispatches your `rollback` action and *your reducer* must know how to undo the
  optimistic change. Nothing is automatic — no snapshot, no layer. This is the
  inverse-patch end of the spectrum, with the patch written by hand per action type.
- **Temporary IDs** are app-managed (generate a client id, reconcile in the `commit`
  reducer when the server returns the real one). **Dependent actions** (create-then-edit
  the same entity offline) need manual coordination. **Conflict resolution** with writes
  that happened server-side while offline is explicitly left to the app.
- At-least-once + serial FIFO is the right baseline for an offline outbox, but note what
  it implies: effects must be **idempotent or deduplicated server-side**, or a retry
  after an ambiguous failure double-applies (catalog #7).

**Failure UX**: only after retries are exhausted does `rollback` fire — so the user may
see a "committed" item for minutes and *then* watch it vanish. The convention is to render
outbox-pending items with a distinct pending affordance; apps that skip this get the
worst ghost-entry UX (catalog #3).

## 6. Firebase — latency compensation, the original

**RTDB** ([offline capabilities docs](https://firebase.google.com/docs/database/web/offline-capabilities)):
every write fires **local events immediately**, before server confirmation; the client's
view is "synced state + pending local writes" merged continuously. Pending writes queue
across disconnects and replay on reconnect. `ServerValue.TIMESTAMP` resolves locally to a
clock-offset **estimate**, then to the real value on confirmation — i.e. even
server-computed fields get a local guess. Transactions (`runTransaction`) may run the
update function **multiple times** against local speculation, and intermediate local
states are briefly visible to listeners.

**Firestore** ([listen docs](https://firebase.google.com/docs/firestore/query-data/listen)):
same model, made explicit — a local write invokes snapshot listeners **immediately** with
`metadata.hasPendingWrites === true`; when the server commits, **the listener fires again**
with `hasPendingWrites === false` (the *server echo*). The app is told, per snapshot,
whether it is looking at optimistic or confirmed data, and the documented convention is a
pending indicator that clears on the echo.

Why this is the architecturally interesting one for Stackbase: there is **no separate
optimistic-update API at all**. Optimism is a property of the *sync protocol* — the local
store applies writes ahead of the server and reconciles on the echo. Rollback happens
only when the server **rejects** the write (security rules), at which point the pending
write is dropped from the merge and listeners fire with the reverted state. No `onMutate`,
no snapshots, no user-written rollback — and crucially **no refetch race**, because the
subscription stream *is* the reconcile path; the echo replaces the pending write
atomically within the same listener. The costs: (a) the write must be expressible as a
client-side state change (Firebase writes are data patches, not server functions — a
Convex/Stackbase mutation is arbitrary server code, so the client can only *approximate*
its effect); (b) the double-fire means naive listeners render twice, and any
server-computed value (timestamps, in Stackbase's case *anything the mutation computes*)
visibly changes on the echo (catalog #2).

## 7. Supabase — no story

Supabase's client libraries have **no optimistic-update or client-state layer at all**;
the official position in [supabase discussion #1753](https://github.com/orgs/supabase/discussions/1753)
is that state management is out of scope for now, users should pair supabase-js with
TanStack Query / Apollo / React's `useOptimistic`, and a future built-in "reactive store"
is an aspiration, not a plan. Realtime (Postgres changes over WebSocket) delivers raw
change events; merging them with local pending writes is entirely the app's problem — and
the combination (self-managed optimistic cache + independent realtime change feed) is
precisely the double-apply minefield of catalog #5. This is a genuine competitive gap:
the mainstream BaaS closest to Stackbase's positioning ships nothing here, while Firebase's
latency compensation is 10+ years old.

---

## The failure-mode catalog

Every optimistic-update design must have an explicit answer for each. Downstream agents:
check proposals against this list by number.

1. **Refetch/invalidation race (revert-flicker).** A refetch triggered by mutation A
   settling returns server state that predates in-flight mutation B; B's optimistic state
   is visibly reverted, then re-applied. TanStack's canonical bug; requires
   `cancelQueries` at start *and* suppressed invalidation while siblings are in flight
   ([TkDodo](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query)).
   Subscription-stream reconcile (Firebase) avoids the class entirely; refetch-based
   reconcile must gate on "no pending local mutations."
2. **Reconcile flicker on mismatch (the echo problem).** The optimistic guess differs
   from the server result (server-computed timestamps/ids/derived fields, or Stackbase
   mutations running arbitrary server logic), so confirmation visibly rewrites the row.
   Firestore's `hasPendingWrites` double-fire is the honest version; the design must say
   what the client can and cannot predict, and how the swap is presented.
3. **Ghost entries.** An optimistically-created item that (a) lingers after its mutation
   failed (rollback missed a cache location / a second list), or (b) sits looking
   committed for minutes in an offline outbox and then vanishes on permanent failure
   (Redux-Offline). Needs: rollback that provably covers every projection of the write,
   plus a visible pending state for queued writes.
4. **Duplicate on confirm (temp-ID reconciliation).** The optimistic item (temp id) and
   the confirmed item (real id) coexist: the list `update` function ran for both
   optimistic and real responses (Apollo [#1100](https://github.com/apollographql/apollo-client/issues/1100)),
   or a refetch landed alongside a not-yet-discarded optimistic layer. Needs a
   deterministic temp-id → real-id identity so the confirm *replaces* rather than *adds*.
5. **Double-apply via an independent change feed.** The client applies the write
   optimistically AND receives the same write through a subscription/refetch that doesn't
   know about the pending local write (Supabase realtime + hand-rolled cache; TanStack
   refetch races). The reconcile path must be able to *match* incoming server state to
   pending local writes — Firebase does this natively; anything bolted-on must dedupe by
   mutation identity.
6. **Non-independent stacking (compounding / wrong-order rollback).** Optimistic update
   B was computed from state that included optimistic update A. Snapshot-restore: rolling
   back A's snapshot erases B (TanStack). Layers: discarding A leaves B's baked-in copy of
   A's effect (Relay's documented counter double-count). Correct behavior on
   rollback-of-A is *recompute B against post-rollback state* — i.e. re-run pending
   updaters over the new base (Relay re-runs updaters; Apollo's re-application step is
   where its open bugs live, [#7341](https://github.com/apollographql/apollo-client/issues/7341)).
7. **Ambiguous failure / retry duplication.** A timed-out or connection-dropped request
   may have committed server-side. Rolling back is wrong if it committed; retrying is
   wrong if not idempotent. SWR's error-dependent `rollbackOnError` acknowledges the
   first half; Redux-Offline's at-least-once queue demands idempotent effects or
   server-side dedup (mutation ids) for the second.
8. **Offline-queue ordering and dependency.** Queued writes must replay FIFO
   (Redux-Offline guarantees this), and a later queued write may depend on an earlier
   one's server-assigned result (create-then-edit with a temp id). The design must either
   rewrite queued payloads on temp-id resolution or scope ids client-side.
9. **Partial-failure UX.** Convention across all libraries: silent automatic revert +
   app-supplied toast. Nobody ships a built-in "this failed, tap to retry" affordance;
   the revert is abrupt. A design that keeps the failed write visible in an error state
   (rather than vanishing it) exceeds the mainstream bar — but must then answer #3.
10. **Cross-view consistency of the optimistic write.** Variables-mode/local-component
    optimism (TanStack variables, React `useOptimistic`) shows the pending state only
    where it's wired; a normalized/store-level layer (Apollo, Relay, Firebase) shows it
    everywhere the entity appears. The design must pick: per-query overlay (simple,
    inconsistent across views) vs store-level overlay (consistent, requires knowing the
    write's effect on every subscribed query — for Stackbase, on every subscribed
    *server-computed query result*, which is the hard part Convex solves by running
    optimistic updates as client-side functions over the local query cache).

**Sources:** [TanStack optimistic updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates) ·
[TkDodo concurrent optimistic updates](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query) ·
[Apollo optimistic UI](https://www.apollographql.com/docs/react/performance/optimistic-ui) ·
[apollo-client #7341](https://github.com/apollographql/apollo-client/issues/7341) ·
[apollo-client #1100](https://github.com/apollographql/apollo-client/issues/1100) ·
[Apollo community: temporary duplicates](https://community.apollographql.com/t/optimistic-mutation-temporary-duplicate-responses/6662) ·
[Relay mutations guided tour](https://relay.dev/docs/guided-tour/updating-data/graphql-mutations/) ·
[SWR mutation](https://swr.vercel.app/docs/mutation) ·
[redux-offline](https://github.com/redux-offline/redux-offline) ·
[Firebase RTDB offline](https://firebase.google.com/docs/database/web/offline-capabilities) ·
[Firestore listen / hasPendingWrites](https://firebase.google.com/docs/firestore/query-data/listen) ·
[Supabase discussion #1753](https://github.com/orgs/supabase/discussions/1753)
