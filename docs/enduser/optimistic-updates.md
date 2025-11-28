---
title: Optimistic Updates
---

# Optimistic Updates

> Instant UI on `useMutation`, exact rollback on failure, no-flicker reconciliation against the
> real commit — Convex-verbatim `withOptimisticUpdate`, over a client whose transport now
> reconnects by default.

A mutation round-trips to the server: your function runs transactionally, commits, and the
result comes back over the WebSocket. That round trip is real latency — normally a handful of
milliseconds, but noticeable in a chat send button or a todo checkbox. `withOptimisticUpdate` lets
you render the *predicted* result of a mutation immediately, in the same tick as the click, and
then swap seamlessly to the real committed value once it arrives — with **no flicker**: the frame
where your guess disappears is always the same frame where the authoritative row appears.

## The API

```ts
// React — opt-in per call site:
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

// Core client (no React):
await client.mutation(api.messages.send, args, { optimisticUpdate });
```

`send(args)` still returns the same promise it always did — calling it now *also* runs your
updater synchronously, before anything hits the wire, so any component reading the patched query
re-renders with the predicted value in the same tick as the click.

The store your updater receives, `OptimisticLocalStore`, is the full surface — nothing else is
part of v1:

```ts
interface OptimisticLocalStore {
  getQuery<Q>(ref: Q, args: FunctionArgs<Q>): FunctionReturnType<Q> | undefined;
  setQuery<Q>(ref: Q, args: FunctionArgs<Q>, value: FunctionReturnType<Q> | undefined): void;
  getAllQueries<Q>(ref: Q): Array<{ args: FunctionArgs<Q>; value: FunctionReturnType<Q> | undefined }>;
  placeholderId(table: string): string;   // deterministic per (entry, table, call-ordinal)
  now(): number;                          // entry-creation time, stable across replays
}
```

`getQuery`/`setQuery`/`getAllQueries` are typed the same way `useQuery` is: pass a codegen `api.*`
reference and `args`/the return value are inferred from that function's declared `returns`
validator (see [Return-type typing](#return-type-typing-add-returns-to-get-a-typed-store) below).
`getAllQueries(ref)` returns every live `(args, value)` pair for that function across all of its
argument variants — useful for patching a paginated or per-id family of queries at once.

Not in v1, and not planned as a near-term follow-on: a `defineLocalMutators` registry, pending/
failed-queue accessors (`usePendingMutations`, `onMutationFailed`), and optimistic **actions**
(actions have no commit timestamp to gate a layer's removal on, so there is nothing sound to build
here).

## What actually happens: the reconciliation contract

Every subscribed query in the client has two layers under the hood: a `serverValue` (only ever
written by data actually received from the server) and a `composedValue` (what your components
see — the server value with any surviving optimistic layers replayed on top, in the order the
mutations were issued). Calling a mutation with `withOptimisticUpdate`:

1. Runs your updater against the current composed view and stacks its writes as a new layer.
   Every component reading a query you patched re-renders immediately.
2. Sends the mutation. Once it commits, the server response comes back carrying the commit's
   timestamp.
3. Your layer is **not** removed the moment the response arrives — it's removed the moment a
   subsequent server push (a `Transition`) demonstrably reflects that commit. That's what makes
   this "no-flicker": the guessed row and the real row are never both absent, and are never shown
   as two different frames in sequence. Convex's `removeCompleted(ts)`, Electric's `write_id`,
   TanStack DB's txid match, and PowerSync's write checkpoints all converge on the same rule —
   drop on **observed inclusion**, never on ack.
4. If the mutation fails server-side, or the connection drops before its outcome is known, your
   layer is dropped and every affected query is recomputed as if it had never run — "rollback" is
   simply "stop replaying this layer," never an inverse operation, so there is nothing to get
   wrong.
5. If several optimistic mutations are in flight against overlapping queries, they stack: each
   layer replays over the previous layer's result, in the order the mutations were called. If an
   earlier one fails, later ones are unaffected and simply replay over the corrected base.
6. A layer that's confirmed but somehow never observes its own inclusion (a lost frame under
   frame-loss) is dropped after 10 seconds (`gateTimeoutMs`) with a console warning — no wrong
   guess and no dropped frame can wedge a stale row on screen indefinitely.

You never interact with any of this directly. It's described here so you know what "instant, then
settles cleanly" is actually guaranteeing.

**A performance note.** Every server push while a mutation is pending re-derives every currently
patched query from scratch (never just the one the push was about), so a component subscribed to
a query with a pending optimistic layer can re-render on a push that, from that query's own point
of view, changed nothing. Measured against the chat example (`examples/chat/test/
optimistic-rerender.test.ts`): one pending optimistic send renders twice (the instant apply, then
the confirming settle); a second, unrelated optimistic mutation pending concurrently in the same
session adds one more render to the first — real, but modest at ordinary concurrency, not a
blow-up. Structural sharing (skip re-deriving a query a given ingest didn't actually touch) is a
known, not-yet-built follow-on if a real app's usage pattern ever makes this measure hot.

## Purity rules: `placeholderId()` / `now()`, never `crypto.randomUUID()` / `Date.now()`

An updater can run **more than once** for the same mutation: every time a new server push arrives
while your mutation is still pending, the client rebuilds the composed view by replaying every
surviving layer's updater from scratch over the fresh base. Your updater must be a **pure,
deterministic** function of `(store, args)` — same inputs, same writes, every time it's replayed.

That's why the store hands you `placeholderId(table)` and `now()` instead of leaving you to reach
for `crypto.randomUUID()` / `Date.now()`:

- `placeholderId("messages")` returns the **same id** every time this mutation's updater replays,
  and a **different, ordinal-distinct id** for the *n*th call within one updater run, and a
  different id again for every other pending mutation. Call it once per new row you're
  optimistically inserting; call it again (a second time, same updater run) for a second row.
- `now()` returns the timestamp fixed when the mutation was created — stable across every replay,
  standing in for `_creationTime` on a row you're inserting.

**Do not call `crypto.randomUUID()` or `Date.now()` inside an updater.** Every replay would mint a
*fresh* value, which the composed view (and React, keying off it) would see as a brand-new,
unrelated row rather than the same optimistic row being re-rendered — remounts, list-key churn,
lost input focus, on every unrelated server push while your mutation is pending. This is a
documented anti-pattern precisely because it's what Convex's own docs example does; we don't
import that footgun. There's no runtime lint that catches this for you — the store's shape is
designed so the deterministic path is also the easy path, not so the impure path is blocked.

## Temp-id constraints

`placeholderId()` returns an opaque string built from the mutation's own entry seed and a
per-table call ordinal (something like `<entropy>:<table>:<ordinal>` — treat the exact shape as
unspecified and never parse it). Two things follow:

- **It is not a decodable `Id<"...">`.** It doesn't round-trip through the server's id codec, and
  it isn't a real row — it exists only so your optimistically-inserted object has *some* stable
  `_id` to key a React list on until the real row arrives and replaces it in the same atomic swap
  described above.
- **Never pass a `placeholderId()` value as an argument to a mutation.** It isn't a real id the
  server can resolve, and there is no mechanism to rewrite a placeholder reference into the real
  id once the create it names has committed — nor will there ever be; that's not the fix. The
  resolution is: **mint a real id instead.** If you need to create a row and then immediately
  reference it (e.g. create a conversation, then send the first message into it), use
  `mintId` (from your app's generated `_generated/ids.ts` — see
  [Client-supplied ids](/offline#client-supplied-ids-create-then-reference-chains) in the offline
  guide) to mint a real `Id<"table">` *before* either mutation is sent, pass it as `_id` on the
  create's args, and reference that same id in the follow-up mutation's args. Both calls can then
  be issued back-to-back — or even queued offline — without ever awaiting the first one to learn
  its id. `await`-then-use-the-server-returned-id still works too, and is the simpler choice when
  you're online anyway and don't need offline support for the pair.

  The same purity rule that governs `placeholderId()`/`now()` applies to minting: **mint OUTSIDE
  the updater**, at args-construction time (minting consults randomness) — and **inside the
  updater, read the id FROM args**, never call `mintId` there. Placeholders and minted ids stay
  cleanly separated by concern: `placeholderId()` remains purely a *rendering* concern (a stable
  React key for a row that doesn't have a real id yet, when you're not client-minting one), while
  a minted id is an *args* concern (a real id, fixed before enqueue, that a later mutation can
  reference). An updater that renders a row created with a minted id should use that real id as
  the row's `_id` — reading it from `args`, exactly like any other field — rather than calling
  `placeholderId()` for it.

## Return-type typing: add `returns` to get a typed store

`getQuery`/`setQuery`/`getAllQueries` are typed from the function reference's declared return
type. That type comes from an explicit `returns` validator on the query, the same way `args`
already works:

```ts
export const list = query({
  args: { conversationId: v.id("conversations") },
  returns: v.array(v.object({
    _id: v.id("messages"),
    _creationTime: v.number(),
    conversationId: v.id("conversations"),
    author: v.string(),
    body: v.string(),
  })),
  handler: (ctx, args) => ctx.db.query("messages", "by_conversation").eq("conversationId", args.conversationId).collect(),
});
```

A function with no `returns` validator still works everywhere — `getQuery` against it just falls
back to the untyped `Value` shape, same as today. Add `returns` incrementally; it's also what
gives the server itself return-value validation (see the argument-validation docs) — this isn't a
one-off cost paid just for optimistic updates.

### The pending-row type-widening recipe

A row your updater inserts is missing every field a real commit fills in that your handler
doesn't set explicitly (nothing server-computed exists yet). There's no first-class "this row is
pending" flag in v1 — planting a literal `pending: true` on the object doesn't typecheck against
`Doc<"messages">` once you've added a `returns` validator. The recipe: widen the type at the call
site of your updater, not in your schema —

```ts
type Message = Doc<"messages">;
type PendingMessage = Message | (Omit<Message, "_id"> & { _id: string; pending?: true });
```

...and render optimistically-inserted rows (`pending === true`, or just: not yet found by real
`_id` lookup) with whatever affordance you want (dimmed, a spinner, etc.) — inferred at your
render site rather than carried as data. A first-class pending-row metadata channel on the store
itself is a named follow-on, not built.

## The dev-mode freeze is shallow

In development builds, every value `getQuery`/`getAllQueries` hands back is passed through
`Object.freeze` before it reaches your updater — mutating it in place (Convex's documented
"corrupts the client's internal state" footgun) throws immediately instead of silently corrupting
reactive state. **This freeze is shallow**: `Object.freeze` only locks the top-level object/array
you were handed — a nested object or array one level down is *not* frozen and can still be
mutated in place without throwing. Always copy-and-replace (`[...list, newRow]`, `{...doc,
field: x}`) rather than mutating, at every level, exactly as you would against a real Convex
optimistic store — the freeze is a development-time tripwire for the most common mistake, not a
deep-immutability guarantee. It's compiled out of production builds entirely (`NODE_ENV ===
"production"`), so it costs nothing at runtime in production either way.

## The promise-timing migration note

**This differs from Convex: `await` confirms commit, not local-cache inclusion.**

`await send(args)` resolves the moment the server's `MutationResponse` for that mutation arrives —
i.e., the mutation has committed. It does **not** wait for the ts-gate described above (the point
where your optimistic layer is provably superseded by an authoritative push). In practice this
makes very little difference: the composed view already shows your write synchronously, the
moment you called `send`, and any query you read *after* `await` resolves reflects the commit on
the server side regardless. The two documented residuals below are the concrete cases where the
difference is visible. We chose response-time resolution because gate-time resolution has two
sharp edges this protocol doesn't yet close: a transport drop can turn a mutation that *did*
commit into a promise that rejects, and a lost gating frame with no follow-on traffic can leave a
promise hanging forever. A gate-time resolution option may be added later, additively, if it turns
out real apps need it.

## Two documented residuals

These are known, inherent-to-the-design edge cases, not bugs:

- **Echo-snap on a wrong guess.** If your updater's predicted value differs from what the server
  actually computed (e.g. the server derives a field your updater didn't predict, or applies
  business logic your client-side guess didn't replicate), the swap from your guess to the real
  value is still a single atomic frame — never a flicker — but the visible content of that frame
  can visibly "snap" from your guess to the real value if they differ. This is inherent to
  optimism over an arbitrary server-side mutation: the more of the server's logic your updater
  predicts, the smaller the snap.
- **`QueryFailed`-on-confirm.** If the *very* server push that would confirm your mutation
  instead carries a `QueryFailed` for the query your updater patched (the query itself started
  erroring), the gate still closes (the timestamp advanced) and your optimistic layer is
  dropped — but per this client's existing keep-last-value-on-error semantics, the base value
  stays whatever it was *before* your write. Your committed, optimistically-shown write becomes
  invisible until the query recovers. This is a corollary of keep-last-value-on-error, not a new
  failure mode this feature introduces.

## Reconnect

The WebSocket transport now reconnects automatically by default — a dropped connection is not a
terminal failure. On disconnect, it retries with exponential backoff and jitter (starting at
300ms, capped around 30s) until the socket reopens.

```ts
// Default: reconnect automatically.
const client = new StackbaseClient(webSocketTransport(url));

// Opt out — restores the old terminal-on-close behavior exactly.
const client = new StackbaseClient(webSocketTransport(url, { reconnect: false }));
```

What survives a dropped connection, and what doesn't:

- **Unsent mutations survive.** A mutation that was queued locally but never made it onto the
  wire before the drop (`unsent`) is retained and automatically flushed, in order, the moment the
  connection reopens.
- **In-flight mutations do not survive.** A mutation that was sent but whose response never
  arrived before the drop has an unknowable outcome — it may have committed, or it may not have.
  Its promise rejects with `MutationUndeliveredError`, and its optimistic layer is dropped. There
  is no automatic retry (a blind resend of a mutation that already committed would double-apply
  it) — catch this error and decide whether your app should retry.
- **Already-completed mutations' layers do not carry across a reconnect**, even though their
  promises already resolved. A fresh connection arrives with a fresh session whose timestamp
  space starts over; replaying an old layer on top of that session's data would replay it on top
  of its own echo. Every live query is automatically re-subscribed against the new session, so
  you get the authoritative current state either way.

On every reconnect, the client also replays your last `setAuth` token (if any) before
re-subscribing, so authenticated subscriptions resume without you doing anything.

## Scope exclusion: the `useQuery` args-change flash

When a component's `useQuery(ref, args)` call re-renders with **different** `args` (a new
`conversationId`, a new search term), it briefly returns `undefined` until the new subscription's
first result arrives — this is shared, pre-existing `useQuery` behavior (unrelated to whether
you're using `withOptimisticUpdate` anywhere) and is explicitly out of scope for this slice.

## What's next: the durable offline outbox

Everything above holds for a live, connected — or briefly reconnecting — session. By itself it
does **not** persist across a page reload or app relaunch — but the durable offline outbox (opt-in
`outbox: indexedDBOutbox()` in the browser, `fsOutbox()` on Node/Electron hosts) has since
shipped and closes exactly that gap: mutations queued durably, survivable and resendable across a
reload, with server-side per-client receipts so a resend can't double-apply. See the
[offline guide](./offline.md) for the full model, including client-supplied ids for offline
create-then-reference chains.
