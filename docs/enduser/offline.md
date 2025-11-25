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
  [Poison handling](#poison-handling-poisonpolicy) below for exactly what happens next.

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
| Client-supplied ids (full offline "create-then-reference" chains) | ids travel inside `args`; its own id-codec spec (forgery, table validation) | Offline cross-mutation create-then-edit (e.g. create a conversation, then immediately send into it, both offline) isn't possible in v1 — the documented workaround is a **composite intent**: do both as one mutation call. The create-then-await-then-reference pattern from Optimistic Updates still requires being online for the awaited step. |
| Subscription resume token | an additive `Connect` field | Reconnect re-sends full query results rather than a diff — fine at today's scale; worth re-measuring as offline-heavy apps get more real-world traffic. |
| Background Sync service-worker drain | a drain-trigger seam | No drain-after-tab-close on a visit; Chromium-only browser feature even if built. |
| Cross-tab live optimistic rendering | the registry + shared store | Another tab's pending writes show up as `pendingMutations()` status, not as rendered rows in your queries, until that tab (or the drain leader) actually observes the commit. |
| A persisted query baseline (a client-side replica) | **not a deferral — a declared non-goal** | Offline-after-reload rendering stays app-effort (see above) permanently, by design — a full client replica is a different, larger product bet this feature deliberately doesn't take on. |

One entry has already graduated out of this table: the Node/Bun filesystem `OutboxStorage` adapter
shipped as `fsOutbox()` — see [Node, Electron, and Tauri hosts](#node-electron-and-tauri-hosts)
above.

Nothing in this table reopens the record family, the wire contract, or the reconcile algorithm —
these are additive follow-ons on top of a design that's already complete and shipped.
