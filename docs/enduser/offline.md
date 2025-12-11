---
title: Offline & Durable Sync
---

# Offline & Durable Sync (the Receipted Outbox)

> Mutations queued while offline survive a reload, drain exactly-once on reconnect, and never
> silently vanish or double-apply — an opt-in feature on top of the reactive client, built for the
> deploy-anywhere, write-sharded engine.

Everything in [Optimistic Updates](/optimistic-updates) holds for a live, connected — or briefly
reconnecting — session. On its own, a mutation that's `unsent` or `inflight` when the page reloads
or the app relaunches is gone. The Receipted Outbox closes that gap: mutations queued while offline
are written to durable storage (IndexedDB in a browser), survive a full reload or crash, and drain
in order once the connection comes back — with server-side per-client dedup so a resend can never
double-apply.

## The model: queue → drain → receipts

Three moving parts:

1. **Queue.** Every `client.mutation(...)` call, while an outbox is configured, is stamped with a
   durable identity — a `clientId` (one per tab-session, minted once at client construction) and a
   `seq` (a per-tab counter, incrementing by one for every mutation you ever call from that tab,
   never reused). The `(clientId, seq)` pair, plus the mutation's function path and arguments, is
   appended to durable storage. This append is **write-behind** — your `mutation()` call still sends
   over the wire immediately if you're online; it never waits for the disk write. If you're offline,
   the entry sits durably as `unsent` until a connection exists.
2. **Drain.** On reconnect, the client sends a `Connect` handshake naming every durable entry it's
   still holding. The server classifies each one and the client sends the still-unresolved ones as
   `MutationBatch` chunks, one unacked chunk in flight at a time, in the order they were originally
   enqueued (FIFO across the whole queue — not just per tab).
3. **Receipts.** Every mutation that actually commits gets a durable server-side record keyed by
   `(identity, clientId, seq)`, written atomically with the mutation's own effects. If your device
   goes offline again mid-drain, or the whole app crashes right after a mutation commits but before
   its response reaches you, the next attempt resends the same `(clientId, seq)` — the server finds
   the existing record and replies with the *original* result instead of re-running your handler.
   Nothing you write is ever silently lost, and nothing is ever silently re-executed.

This is why it's called the *Receipted* Outbox: every applied mutation leaves a receipt the server
keeps around specifically so a resend can be recognized, rather than relying on the queue itself
staying in strict lockstep with the server (which is what breaks under a crash or a lost response).

## Enabling it

The outbox is entirely **opt-in**. A client constructed without an `outbox` behaves exactly as it
does today — nothing about this feature changes byte-for-byte unless you configure it.

```ts
import { StackbaseClient, webSocketTransport, indexedDBOutbox } from "@stackbase/client";

const client = new StackbaseClient(webSocketTransport(url), {
  // Durable, IndexedDB-backed. Probes for IndexedDB and transparently falls back to an in-memory
  // queue wherever it's unavailable (Node, private-mode Safari, a corrupt origin) — same API either
  // way, so your app code never has to branch on it.
  outbox: indexedDBOutbox(),

  // The registry: rebuilds an optimistic layer for a durable entry hydrated after a reload, keyed
  // by the function's path. See "Offline-after-reload rendering" below — this is what makes queued
  // rows visible again before the drain has actually run.
  optimisticUpdates: {
    "messages:send": (store, args) => {
      const list = store.getQuery("messages:list", {}) as Array<{ _id: string; body: string }> | undefined;
      if (list === undefined) return; // no persisted query cache yet — render nothing, not a crash
      const { body } = args as { body: string };
      store.setQuery("messages:list", {}, [...list, { _id: store.placeholderId("messages"), body }]);
    },
  },

  onMutationFailed: (info) => { /* a terminal, server-recorded failure with no live promise awaiting it */ },
  onClientReset: (info) => { /* the server disowned this client's history — see below */ },
});
```

There's also `memoryOutbox()` — the same identity/dedup machinery (every mutation still gets a
`(clientId, seq)`, still gets exact-once server receipts, still gets the FIFO drain-on-reconnect
behavior) but backed by a plain in-memory Map instead of IndexedDB, so nothing survives a reload.
Use it where persistence doesn't make sense (SSR, tests) but you still want the reconnect-safe
delivery guarantees, or as the coexistence mechanism described near the bottom of this page.

### Node, Electron, and Tauri hosts

Outside a browser there is no IndexedDB — for Node/Bun processes, Electron main processes, and
Tauri sidecars, use `fsOutbox()`, the filesystem-backed `OutboxStorage`. It ships as its own
subpath export so browser bundles never see its `node:*` imports:

```ts
import { StackbaseClient, webSocketTransport } from "@stackbase/client";
import { fsOutbox } from "@stackbase/client/outbox-fs";

const client = new StackbaseClient(webSocketTransport(url), {
  // One durable queue per directory: an append-only journal (journal.jsonl) plus a lock file,
  // created on first use. Same OutboxStorage contract as indexedDBOutbox() — reload/crash
  // survival, exactly-once drain via server receipts, pendingMutations() — no app-code branching.
  outbox: fsOutbox({ dir: "./data/outbox" }),
});
```

The rules that differ from the browser backend:

- **One writer per directory.** The dir is guarded by a pid lock file; a second process (or a
  second `fsOutbox()` in the same process) opening the same dir doesn't throw — it transparently
  falls back to `memoryOutbox()` (no cross-restart durability, everything else identical), firing
  the optional `onFallback: (reason) => …` callback once so you can log it. A lock left behind by
  a crashed process is detected (dead pid) and stolen automatically on the next open; correctness
  never rests on the lock — the server-side receipts absorb any overlap, exactly as they do for
  multi-tab browsers.
- **Local disk only for the lock.** The lock's semantics assume a local filesystem — on a network
  filesystem (NFS, SMB) pid-based liveness probing and atomic-create behavior aren't reliable, so
  point `dir` at local disk.
- **Electron: split by process.** Renderer processes are browsers — keep `indexedDBOutbox()`
  there. Use `fsOutbox()` in the main process or a Node sidecar (and the same for Tauri sidecars),
  each with its own queue dir.
- `fsync` on every append is the default (`fsOutbox({ dir, fsync: false })` trades crash-durability
  of the very last writes for throughput), and `await outbox.close?.()` on shutdown releases the
  dir lock promptly (a SIGKILL'd process's lock is reclaimed on the next open anyway).
- **A disk I/O error (disk full, a permissions change, a yanked network mount) fails the queue
  stop, not silently.** Once a write to the journal fails, that `fsOutbox()` instance stops
  accepting further writes — every subsequent mutation's durable append rejects, rather than
  quietly falling back to in-memory-only state and pretending nothing happened. Work already
  queued is safe on disk; the app itself keeps running; new mutations surface the failure through
  `onMutationFailed` (or, with no handler registered, a dev-mode `console.error`) instead of ever
  becoming an unhandled promise rejection — which several Node/Electron hosts otherwise treat as
  fatal. Recovery is a process restart: the fresh instance re-hydrates the journal from disk, and
  server-side receipts make any resend of an already-applied mutation safe. Hosts that use
  `fsOutbox()` should watch `onMutationFailed` to detect and react to this case (alert, prompt a
  restart, etc.) rather than assuming every failure is an ordinary mutation error.

### The armed-after-first-connect note

Durability of a *queued, never-sent* mutation is unconditional the moment an outbox is configured —
it's written to durable storage regardless of connection state, full stop. But the safe **parking**
of a mutation that was already *sent* when the connection drops — the case where the outcome is
genuinely unknown, because the response may or may not have made it back — only activates once the
client has connected at least once and the server has proven, via `ConnectAck`, that it speaks this
dedup protocol. Until that handshake completes, an in-flight mutation whose connection drops still
rejects with `MutationUndeliveredError`, exactly as it does without an outbox at all. In practice
this means: the very first connection your app ever makes (per tab-session) needs to succeed before
a badly-timed disconnect gets park-and-resume treatment instead of a rejection. Every reconnect
after that first successful handshake is covered. Pointed at an older server that predates this
feature, the client simply never arms — the same `MutationUndeliveredError` fail-fast behavior,
forever, with no error and no special handling required on your end.

### What a reconnect costs

Reconnecting doesn't mean re-downloading everything you were subscribed to. Every server-pushed
query result now carries a content fingerprint; on reconnect, the client echoes back the
fingerprint it last saw for each still-live subscription, and if the server's fresh re-run hashes
the same, it answers with a tiny `QueryUnchanged` marker instead of resending the value —
typically **>90% less reconnect traffic** for data that didn't change while you were offline (a
same-substrate benchmark measured a 99.3% byte reduction in the all-unchanged ceiling case; see
`docs/dev/research/reconnect-resume-benchmark.md`). Whatever *did* change arrives in full, exactly
as before. This is entirely automatic — no configuration, nothing to opt into — and degrades
gracefully: an older server that predates fingerprinting simply never receives an echoed hash and
falls back to sending full results, byte-for-byte the same as before this shipped. One honest
caveat: this saves *bandwidth*, not *compute* — every subscribed query still fully re-executes on
reconnect either way, fingerprint or not. Skipping the re-run itself (a retained-read-set resume)
is the deferred v2 seam, not this.

## Client-supplied ids: create-then-reference chains

The outbox above gets you exactly-once delivery of a *single* queued mutation. The next question
is what happens when two queued mutations depend on each other — the classic case is "create a
conversation, then send the first message into it," both issued while offline, where the second
mutation needs to reference a row the first one hasn't committed yet. Client-supplied ids close
that gap: you mint a **real** `Id<"table">` on the client, before either mutation is sent, and pass
it as `_id` on the insert. The engine accepts it (subject to the restrictions below) instead of
minting its own, so the id is valid — and referenceable — the instant it's minted, not the instant
it lands.

This is the **primary** pattern for offline create-then-reference chains. Reach for it whenever a
queued mutation needs to hand a row's identity to a later queued mutation before the first one has
actually run.

### Worked example

`stackbase codegen` (and `stackbase dev`'s regeneration on every push) emits `_generated/ids.ts`: a
`tableNumbers` map for your app's own tables plus a typed `mintId`:

```ts
import { mintId } from "../convex/_generated/ids";

const conversationId = mintId("conversations");            // a REAL Id<"conversations">, minted now

await client.mutation(api.conversations.create, { _id: conversationId, name });   // queued offline
await client.mutation(api.messages.send, { conversationId, body });               // references it, also offline
```

Both calls enqueue into the durable outbox exactly like any other mutation — no special-casing
needed for the fact that the second one references a row the first one hasn't committed yet. On
drain, `conversations.create` runs first (the outbox is FIFO), inserts under the minted id, and by
the time `messages.send` runs, the reference resolves against a real row. The receiving mutation
just accepts the id as a normal `v.id("conversations")` argument — from the handler's point of
view, nothing about this is different from an id it received any other way.

On the write side, your mutation passes the supplied `_id` straight through to `ctx.db.insert`:

```ts
export const create = mutation({
  args: { _id: v.optional(v.string()), name: v.string() },
  handler: (ctx, args) => ctx.db.insert("conversations", args),
});
```

`_id` is optional — a caller that omits it gets an engine-minted id exactly as before. Nothing
about ordinary (non-client-minted) inserts changes.

### The purity rule

Mint at **args-construction time**, outside any `withOptimisticUpdate` updater. Minting consults
randomness (the same 128-bit entropy the engine itself uses); an updater must stay pure and
replay-safe, so it reads the id **from args**, never mints one itself:

```ts
const conversationId = mintId("conversations"); // minted OUTSIDE the updater, once

const send = useMutation(api.conversations.create).withOptimisticUpdate((store, args) => {
  // inside the updater: read the id FROM args — never call mintId() here
  const list = store.getQuery(api.conversations.list, {});
  if (list === undefined) return;
  store.setQuery(api.conversations.list, {}, [...list, { _id: args._id, name: args.name }]);
});

await send({ _id: conversationId, name });
```

This mirrors the existing `placeholderId()`/`now()` purity rule from
[Optimistic Updates](/optimistic-updates) — minting is a one-shot, args-construction-time concern;
replaying an updater must never re-mint. `placeholderId()` itself is untouched by any of this: it
remains a rendering-only concern for a row your updater displays before *any* id — minted or
server-assigned — is known to have committed.

### v1 restrictions (read before you rely on this)

- **Unsharded tables on the default ring only.** A client-supplied `_id` is accepted only when the
  target table has no `shardKey` **and** the mutation is executing on the default ring (i.e. it
  wasn't routed elsewhere via `shardBy`). Both conditions are checked before the id is even looked
  up. Concretely: **don't shard-route a mutation that inserts with a client-supplied `_id`.** If you
  do, it doesn't fail outright — a `shardBy`-routed mutation's client-id insert succeeds only when
  its shard key happens to hash onto the default ring (roughly a 1-in-*N* chance on an *N*-shard
  fleet), and silently gets a typed rejection the rest of the time. Treat that as "unsupported,"
  not "flaky" — keep client-id-minting mutations un-routed (no `shardBy`) and targeting unsharded
  tables. Sharded-table support (binding a client-supplied id to its row's shard-key value) is a
  deferred follow-on, not built.
- **`mintId` covers your app's own tables, not everything `Id<>` can name.** Its type parameter is
  `TableNames`, so it type-checks against any table name your schema knows about — including
  system tables like `"_storage"` — but the emitted map only contains your app's own tables;
  component and system tables are excluded by construction. Calling `mintId("_storage")` compiles
  and throws at runtime ("unknown table … — regenerate `_generated/`"). `mintId` is for minting ids
  of rows your own mutations insert — not a general-purpose id constructor.
- **The map can go stale.** `_generated/ids.ts` bakes in table numbers from whatever composition
  codegen last saw. A deployment that's evolved through many additive schema changes can, in
  principle, drift from a freshly-generated map's assumed numbering. The engine never trusts the
  client's map — every minted id is validated server-side at insert regardless of where it came
  from, so a stale map produces a loud, typed rejection, never a wrong-table write. If you hit one,
  regenerate against a `stackbase dev` session attached to the live deployment's lineage (its
  regeneration path threads the live composition's actual numbers).

### Error codes

A rejected client-supplied id surfaces as one of two stable, matchable error codes — safe to branch
on in `onMutationFailed`/`pendingMutations()` (outbox) or a rejected promise (online):

- **`INVALID_CLIENT_ID`** — the `_id` is malformed, targets the wrong table, targets a sharded
  table, or was inserted by a mutation running off the default ring (see the restrictions above).
- **`ID_ALREADY_IN_USE`** — a document with that id already exists. There's no upsert semantics
  here: an outbox resend never re-executes a committed mutation (receipts replay the recorded
  verdict instead), so this means either a genuine 2^-128-scale collision or an app bug (reusing an
  id outside the outbox's own replay machinery). Either way it's a loud error, not a silent merge.

### Fallback: composite intent

If you can't regenerate `_generated/ids.ts` against your live deployment right now (see the
staleness note above) — or you're on an older client that predates this feature — the previous
workaround still works: fold the create and the reference into **one** mutation call instead of
two. Since a single mutation is one transaction, there's no cross-mutation reference to resolve:

```ts
export const createConversationWithFirstMessage = mutation({
  args: { name: v.string(), body: v.string() },
  handler: async (ctx, { name, body }) => {
    const conversationId = await ctx.db.insert("conversations", { name });
    await ctx.db.insert("messages", { conversationId, body });
    return conversationId;
  },
});
```

This still works today and always will — it's just no longer the primary recommendation once
`mintId` is available, since it forces you to design your mutation API around what needs to be
created together rather than what's logically separate.

## The conflict taxonomy (AC8.1)

Stackbase has **no merge and no CRDT layer**. There is no automatic conflict resolution, offline or
online — your mutation *handler* is the single source of truth for what happens when a queued write
finally runs, exactly as it already is for two concurrent online mutations. When a queued mutation
finally drains, it runs against whatever the server's actual state is *at that moment* (not whatever
it was when you were offline), and one of exactly three things happens:

- **It succeeds.** Your handler ran, computed against live data, and committed. This is the common
  case and needs nothing special from you — it's the same transactional guarantee every mutation
  gets online.
- **It's a no-op by your own handler's logic.** If your handler is written to check-before-write
  (e.g. "only insert this comment if one with the same idempotency key doesn't already exist"), that
  logic runs exactly as written — the outbox has no opinion about what counts as a duplicate or a
  conflict at the data level. This is the idiom for anything you'd otherwise reach for a CRDT for.
- **It's terminal.** Your handler throws, or a validation/authorization check rejects the call. See
  [Poison handling](#poison-handling-poisonpolicy) below for exactly what happens next. If your
  handler needs a queued entry to terminal-fail (rather than retry), throw a **typed, coded** error
  (a `UserError` subclass) — a plain `Error` carries no code on the wire, so the drain can't tell it
  apart from an infrastructure hiccup and treats it as transient, retrying it, by design.

There's no fourth branch where the outbox tries to reconcile your write against someone else's —
that's a deliberate scope line, not a gap. If your app needs true conflict merging, that's app-level
logic inside your mutation handler, the same way it would be for any two racing online writers.

## The boundaries, honestly

### Offline-after-reload rendering is app-effort

There is no persisted query cache/baseline in this design — that's the client-replica product, a
different (and much larger) bet, deliberately not built here. Concretely: **while genuinely
offline, right after a reload, a `useQuery` you haven't yet reconnected for renders `undefined`,**
same as it always has before any subscription result has ever arrived. The registry's rebuilt
optimistic layers (the `optimisticUpdates` map above) only render on top of a query that's actually
subscribed and has *some* base to compose over — so a registered updater must tolerate `undefined`
and simply render nothing until the real baseline exists, rather than throwing:

```ts
const appendMessage: OptimisticUpdateFn = (store, args) => {
  const list = store.getQuery("messages:list", {}) as Array<{ _id: string; body: string }> | undefined;
  if (list === undefined) return; // renders nothing until the baseline arrives — never throws
  const { body } = args as { body: string };
  store.setQuery("messages:list", {}, [...list, { _id: store.placeholderId("messages"), body }]);
};
```

Once you reconnect, the baseline Transition arrives, the registry rebuilds every hydrated entry's
optimistic layer over it, and your queued writes become visible immediately — *before* the drain has
actually committed them — then settle cleanly to the authoritative rows with no flicker, the same
no-flicker guarantee [Optimistic Updates](/optimistic-updates) describes for the live case.

Until then, the honest UI affordance is a **pending tray** — a durable, reactive list of everything
still queued, independent of whether any particular query has a cache to render into. That's what
`usePendingMutations()` is for.

### The pending-tray recipe

```tsx
import { usePendingMutations } from "@stackbase/client/react";

function PendingTray() {
  const pending = usePendingMutations();
  return (
    <ul aria-label="pending-tray">
      {pending.map((entry) => (
        <li key={`${entry.clientId}:${entry.seq}`} aria-label="pending-row">
          <span aria-label="udfPath">{entry.udfPath}</span>
          <span aria-label="status">{entry.status}</span>
          {entry.status === "failed" && (
            <>
              <span aria-label="error">{entry.error?.message}</span>
              <button onClick={() => void entry.retry()}>retry</button>
              <button onClick={() => void entry.dismiss()}>dismiss</button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
```

`usePendingMutations()` reads the durable store directly (not the live in-memory reconciler), is
reactive to local changes, and re-renders on a cross-tab nudge (a `BroadcastChannel` message) when
another tab's queue changes — so the tray stays accurate no matter which tab actually ends up
draining a given entry. `client.pendingMutations()` (the promise-returning core-client method) and
`client.pendingSummary()` (a cheap `{count, oldestEnqueuedAt, oldestAgeMs}` advisory, useful for a
"you have offline changes that may be lost soon" banner — see the eviction note below) are the
non-React equivalents.

### Safari 7-day + eviction honesty

Browser-persisted storage is **best-effort, not guaranteed**. Safari in particular can evict an
origin's IndexedDB data after roughly 7 days of no user interaction with the site; any browser can
evict under storage pressure; a user can clear site data at any time. `indexedDBOutbox()` calls
`navigator.storage.persist()` on your behalf (via `outbox.persist()`, which you can also call
yourself) to *request* durable storage, but **this is advisory only — no behavior in this feature
ever branches on whether the browser actually grants it.** There is no fallback dance, no polling
for the grant, no different code path either way. If the whole origin's storage is evicted, the
queue, the tab's `clientId`, and its next-`seq` counter are all gone together (they live in the same
database, deliberately, so they can never drift out of lockstep) — any mutations that already
drained are unaffected (their receipts and effects are safely on the server); anything still queued
is simply gone, with nothing left behind to even report that it happened. This is a hard, physical
limit of browser storage, not a bug in this feature, and no design can make it otherwise — it's
priced honestly rather than hidden.

The server-side receipts, independently, are retained for a full **30 days** past when they're
acknowledged (plus prompt pruning once a client acks past them), and the per-client floor rows that
make pruning safe are retained for **at least a year**. In other words: the server-side half of this
system will outlive any browser-side queue's realistic lifetime by a wide margin — the practical
constraint on how long a mutation can safely stay queued offline is the browser's storage lifetime,
not the server's retention window.

### Bounded offline (days, platform-limited)

Put together, this is a **bounded-offline** design, not an unbounded one: it's built for "closed my
laptop overnight" or "was on a plane," not "used the app for a month with no network." Use
`pendingSummary()`'s `oldestAgeMs` to surface an advisory banner before you get anywhere near a
platform eviction cliff — the queue itself won't warn you.

## Poison handling (`poisonPolicy`)

A mutation can fail two different ways once the drain actually sends it:

- **Coded (terminal).** The server ran your handler and it deterministically failed — a validation
  error, an authorization check, a thrown app error — and recorded that verdict durably. Nothing
  about retrying it would change the outcome; the server has already made its decision permanently.
- **Codeless (transient).** An infrastructure-level failure — the request never got a chance to
  record any verdict at all. This is always safe to retry.

The drain's default policy, `poisonPolicy: "skip"` (the default — you don't need to set it), settles
a coded failure terminally (visible via `onMutationFailed`/`pendingMutations()`, with `error.code`
set) and **keeps draining the rest of the queue** — one bad mutation can never wedge every mutation
queued behind it. A codeless failure instead backs off (jittered exponential backoff, same shape as
the scheduler's retry policy) and resends starting from the failed entry, never skipping it.

If your app would rather stop and let the user intervene the moment *anything* fails — a stricter,
opt-in posture — set `poisonPolicy: "pause"` and register `onOutboxPause`:

```ts
const client = new StackbaseClient(transport, {
  outbox: indexedDBOutbox(),
  poisonPolicy: "pause",
  onOutboxPause: (info) => {
    // info: { requestId, udfPath, code } — the drain has HALTED here; nothing after it will
    // be attempted until you call `.retry()`/`.dismiss()` on the offending entry (see below).
  },
});
```

## Managing failed mutations: `retry()`/`dismiss()`

A `"failed"` entry is never silently dropped — it persists in the durable store until you either
retry or dismiss it (see the pending-tray recipe above). `entry.retry()` re-enqueues it under a
**fresh** `(clientId, seq)` pair — the old seq's durable record permanently *is* its original
verdict (per the governing rule: a `(clientId, seq)` pair is written exactly once, forever — never
reused for a different attempt), so a retry is always a brand-new mutation as far as the server's
dedup is concerned, using the same function path, arguments, and (if one is registered) optimistic
updater as the original. `entry.dismiss()` permanently forgets it without retrying. Neither call
returns the eventual outcome as a promise the way `client.mutation()` does — like every durable
entry, its fate surfaces through `usePendingMutations()`/`onMutationFailed`, not a returned value,
because the durable record outlives any one page load's promises.

## `onClientReset`: what it means, what your app does

The server occasionally has to **disown** a client's mutation history rather than answer honestly —
this happens when a queued `seq` falls below what the server can still account for (its records were
pruned, or — far more rarely — the deployment's whole timeline was reset, e.g. restored from an
older backup) and it can no longer tell whether that mutation applied. Rather than guess (which could
mean silently re-running something that already committed), the server answers `known: false` on the
next `Connect` handshake, and the client:

- Re-enqueues every `"unsent"` entry (one that was queued but genuinely never reached the server)
  under a freshly minted `clientId` and new `seq`s — always safe, since it never applied.
- Rejects every `"parked"` entry (one that was sent and whose outcome is now unknowable) loudly, with
  `OfflineClientResetError` — never a silent guess.
- Fires your `onClientReset(info)` callback, with `{oldClientId, newClientId, unsentReEnqueued,
  parkedRejected}`.

Register it to tell the user plainly: *"some pending changes couldn't be confirmed and may need to
be redone."* Given the 30-day/1-year retention windows above, hitting this in practice means a
device was offline for a genuinely long stretch, or a deployment was restored from a backup — not
routine behavior.

## `STALE_CLIENT`

You may also see a terminal failure with `error.code === "STALE_CLIENT"` on an individual entry (via
`onMutationFailed`/`pendingMutations()`) without a full client reset. This is the narrower, per-entry
version of the same idea: this one queued `seq` specifically falls below the server's per-client
floor with no record on file for it — the server genuinely cannot tell whether it applied — so,
following the same never-silently-re-execute rule, it disowns just that entry loudly rather than
guessing. As with `onClientReset`, this should only happen after an unusually long offline stretch;
it is the honest "we no longer know" answer, not a bug to work around.

## Multi-tab semantics

Each browser tab gets its **own `clientId`**, minted once when its `StackbaseClient` is constructed
and never reused across a reload — a fresh page load always mints a fresh one. Every tab open against
the same origin shares one durable database, though, so they share **one queue**: a
[Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)-elected leader tab drains
the **entire shared queue** — every tab's entries, under each entry's own recorded `(clientId, seq)`,
not just the leader's own writes. If the leader tab is closed mid-drain, another open tab takes over
the lock and finishes the job; nothing is lost or double-applied, because correctness comes from the
server-side receipts, not from the lock. Web Locks are purely an efficiency optimization — a browser
with no Web Locks support at all still drains correctly, just without the "exactly one active
drainer" coordination (falls back to running the drain locally in every tab that has one; the
receipts still absorb any resulting overlap so nothing double-applies).

### Cross-tab live optimistic rendering

Another tab's durable pending mutations **render live in your queries**, not just as a
`pendingMutations()` status entry — as long as you've configured an `optimisticUpdates` registry (the
same registry that already powers offline-after-reload rendering above; a registry consenting to
render a durable entry's layer does so whether that entry was hydrated at construction or arrives
live over the shared `BroadcastChannel` while you're already running). Only that tab's **active**
durable entries mirror — the tab that actually called `mutation()` drives its own entry from its own
wire responses, never from the broadcast. Apps with no registry configured keep today's status-only
behavior: you'll see the entry in `usePendingMutations()`, but nothing renders into your query
results until you subscribe a registry updater for that path.

**The one honest residual: a single, self-healing doubled frame.** When another tab (A) drains a
mutation you (tab B) are also live-subscribed to, B's own subscription can observe the committed row
via its normal server push **before** A's settle broadcast has had time to reach B — A's settle path
is a full round trip (A → server → A) plus a `BroadcastChannel` hop, while B's own live push is a
single server → B hop off the very same commit. In that ordering you'll see one transient frame with
both the committed row and the still-active mirrored placeholder, which **self-corrects on the very
next push** — it never lingers, never grows, and the row is never *absent* at any point. This is a
structural property of the two paths' relative latency, not a bug, and it's proven end-to-end in
`packages/cli/test/crosstab-e2e.test.ts`.

If your UI genuinely cannot tolerate even that one transient frame, write the registry updater as
**idempotent**, keyed on a client-supplied id ([`mintId`](#client-supplied-ids-create-then-reference-chains)):
mint the id before the mutation is sent, use it as the placeholder row's `_id`, and have the updater
check whether a row with that id is already present in the query result before inserting:

```ts
const messageId = mintId("messages"); // minted once, before either mutation call

const registry = {
  "messages:send": (store, args) => {
    const list = store.getQuery("messages:list", {}) as Array<{ _id: string }> | undefined;
    if (list === undefined) return;
    if (list.some((row) => row._id === args._id)) return; // already present — no duplicate insert
    store.setQuery("messages:list", {}, [...list, { _id: args._id, body: args.body }]);
  },
};

await client.mutation("messages:send", { _id: messageId, body });
```

Because the placeholder and the eventual committed row share the same id, an updater written this way
collapses the transient double to a single row on every replay, including the frame where the raw
mechanism would otherwise show both.

**Missed-broadcast backstop.** `BroadcastChannel` delivery isn't guaranteed against every possible
teardown timing. If a settle message is missed, the next `enqueued` re-read (any tab's next durable
append triggers one) reconciles a mirrored entry that's gone missing from the store against reality
and drops it unconditionally — the rare cost is the same one-frame residual described above, not a
stuck row.

### Draining after the tab closes (Chromium)

Everything above assumes at least one tab is open. If every tab closes with entries still queued,
nothing drains until you reopen the app — the durable queue is unaffected (nothing is lost), it just
sits until the next visit. Chromium's one-shot [Background
Sync](https://developer.chrome.com/docs/capabilities/periodic-background-sync) API lets a Service
Worker drain in the background even after every tab is gone, using the same headless
`drainOutboxOnce` export the rest of this feature is built on:

```ts
// sw.ts — inside your Service Worker
import { drainOutboxOnce } from "@stackbase/client";

self.addEventListener("sync", (event) => {
  if (event.tag === "stackbase-outbox-drain") {
    event.waitUntil(
      drainOutboxOnce({
        url: "wss://your-deployment.example.com",
        // The SW has no access to your app's in-memory auth state — it must read from
        // somewhere the SW itself can reach (IndexedDB, a Cache entry, etc). Providing and
        // keeping that store fresh is your app's job; this is the constraint, not a recipe.
        getAuthToken: async () => await readAuthTokenFromSwReadableStore(),
      }),
    );
  }
});

// In your page, after registering the SW:
const registration = await navigator.serviceWorker.ready;
await registration.sync.register("stackbase-outbox-drain");
```

`drainOutboxOnce` is the same queue → drain → receipts model described above, minus everything
UI-shaped — no `StackbaseClient`, no queries, no optimistic layers, just
`{ drained, failed, remaining }` counts. If a live tab already holds the Web Locks leadership, a
concurrent `drainOutboxOnce` call is a safe no-op (`{drained: 0, ...}`) — the tab is already doing the
job.

**The honest limits.** One-shot Background Sync is a **Chromium-only** browser feature — Firefox and
Safari have never shipped it (roughly 76% of global browser share has it at all, and that number
moves). Treat this as strictly additive: it changes *when* a drain can run (potentially while no tab
is open), never the durability story itself — the portable baseline, on every browser, remains "queue
survives, drains on your next visit," which is true with or without this recipe wired up.

## Coexisting with an external mutation/retry layer

If your app already has its own offline-mutation machinery (a different queue/retry library) and you
just want the same exactly-once guarantee this feature gives you, you have two options:

- **The easy path: let our outbox do it.** Configure `outbox: memoryOutbox()` (or
  `indexedDBOutbox()`, if you also want persistence) and every `client.mutation()` call
  automatically gets a `(clientId, seq)` pair stamped and dedup'd server-side — you don't have to
  hand-roll anything.
- **The wire-level path, for a library that manages its own queue/retries end to end** and doesn't
  go through `@stackbase/client`'s `mutation()` call at all: the sync protocol's `Mutation` message
  itself carries the durable identity pair — `{ type: "Mutation", requestId, udfPath, args, clientId,
  seq }`. Mint your own stable per-session `clientId` and a monotonically increasing `seq` (never
  reused for a different logical mutation, exactly the discipline this feature follows internally)
  and stamp them on every send your library makes; the server dedups on `(identity, clientId, seq)`
  exactly the same way, whether the sender is our outbox or yours. Because these records are
  **exact-match, not a FIFO watermark**, there's no server-side gap-rejection to trip over — an
  external retrier is free to resend out of order, and every resend still classifies correctly.
  Don't enable both at once for the same logical mutation stream: if your library already owns
  retries, leave `outbox` unset on the client so the two don't double-manage the same delivery.

## Performance

Headline numbers from the four-axis benchmark (`docs/dev/research/offline-outbox/benchmark.md`,
generated by the flagship E2E driving a real client against a real server — treat the *shape*, not
the exact figures, as the takeaway; they're machine- and load-dependent):

- **Online round-trip cost with the outbox configured vs. not: ≈ 0.** The durable append is
  write-behind — a mutation's wire send never waits for it — so turning the outbox on doesn't move
  your online p50/p99 latency (measured delta: **+0.002ms p50, −0.012ms p99** over 120 sequential
  mutations — noise, not a real cost).
- **Concurrent online throughput with the outbox on: ~13,300 ops/s** (400 concurrent mutations, no
  per-client serialization by design — the outbox never forces concurrent live writers onto a single
  ordered lane).
- **500-entry offline drain: ~675ms time-to-empty**, with the longest single main-thread block during
  the whole drain only **~3.3ms** — the batched `MutationBatch` drain never blocks the UI thread for
  a noticeable stretch, even clearing a large backlog.
- **Durable storage cost: ~2–3 IndexedDB logical operations per mutation** across the full lifecycle
  (append at enqueue, one status transition, one dequeue), write-behind-batched per microtask so the
  *physical* transaction count is bounded further still.

## What's next: the follow-on queue

The slice shipped here deliberately leaves some things for later — each one is a scoped, reversible
deferral, not a gap in the design (verdict §(i)):

| Deferred | Where it lands when built | Honest cost today |
|---|---|---|
| A persisted query baseline (a client-side replica) | **not a deferral — a declared non-goal** | Offline-after-reload rendering stays app-effort (see above) permanently, by design — a full client replica is a different, larger product bet this feature deliberately doesn't take on. |

Every other entry that ever sat in this table has now graduated: the Node/Bun filesystem
`OutboxStorage` adapter shipped as `fsOutbox()` (see [Node, Electron, and Tauri
hosts](#node-electron-and-tauri-hosts) above), client-supplied ids for offline create-then-reference
chains, shipped as `mintId` (see [Client-supplied
ids](#client-supplied-ids-create-then-reference-chains) above), the subscription resume token,
shipped as server-minted per-query result fingerprints (`resultHash`/`QueryUnchanged` — see [What a
reconnect costs](#what-a-reconnect-costs) above), and — most recently — the browser UX pair:
**cross-tab live optimistic rendering** (see [Cross-tab live optimistic
rendering](#cross-tab-live-optimistic-rendering) above, including the one honestly-documented
doubled-frame residual and the idempotent-updater recipe for callers who need zero tolerance) and the
**Background Sync service-worker drain** (see [Draining after the tab closes
(Chromium)](#draining-after-the-tab-closes-chromium) above, `drainOutboxOnce`). Only the *compute*-
saving half of subscription resume (retained read-sets, so an unchanged query skips its re-run rather
than just its resend) remains deferred — see CLAUDE.md's "Honestly deferred" list.

Nothing in this table reopens the record family, the wire contract, or the reconcile algorithm —
these are additive follow-ons on top of a design that's already complete and shipped.
