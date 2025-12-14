# `examples/offline-demo` ("Packlist") — design

**Date:** 2025-11-28
**Status:** Approved
**Goal:** A runnable example app that makes the shipped durable offline sync story *visible*: the
Receipted Outbox (queue → reload → drain → exactly-once), optimistic updates, the `mintId`
create-then-reference chain, the pending-mutations tray, cross-tab live rendering, and the honest
failure path (a queued write that terminally fails on drain). The example is a **pure consumer of
shipped public APIs** — no engine or client-package changes.

## Decisions taken (with the user, 2025-11-28)

1. **App shape: trip packing lists** — `lists` + `items`, chosen because creating a list and then
   adding items to it while offline naturally exercises the `mintId` create-then-reference chain.
2. **Offline simulation: in-app toggle** — a "Go offline" switch in the header, persisted in
   `sessionStorage` so a reload while "offline" stays offline (this is what makes the
   reload-survival half of the story visible without a Service Worker). *(post-review correction:
   sessionStorage — per-tab isolation keeps Flow 2 coherent; localStorage would force late-opened
   tabs offline)*
3. **Failure demo: included** — a server-side rule (items rejected once a list is locked) so a
   doomed queued write visibly terminal-fails on drain, with retry/dismiss in the tray.
4. **Toggle mechanism: demo-local wrapper transport** (Approach A) — a ~50-line implementation of
   the public `ClientTransport` interface inside the example's own `web/` code. A first-class
   `client.suspend()/resume()` API (Approach B) was considered and deferred: it is a product
   feature with its own design surface, and the wrapper proves the ergonomics first.

## Structure

Mirrors `examples/chat` file-for-file (same scripts, same codegen pattern, same
`stackbase dev --dir convex --web web` serving), on **port 3220** so both examples can run
side-by-side:

```
examples/offline-demo/
  package.json            # scripts: dev, codegen, web:build, typecheck, test
  tsconfig.json
  # (no stackbase.config.ts — the file is optional and this project composes no components)
  convex/
    schema.ts             # lists, items (both UNSHARDED — see mintId restriction below)
    lists.ts              # list, create, lock
    items.ts              # list, add, toggle
    _generated/           # codegen output (api, dataModel, server, ids)
  web/
    index.html
    main.tsx              # the React app
    offline-transport.ts  # the wrapper ClientTransport with setOffline(bool)
    main.js               # built bundle (bun build web/main.tsx)
  scripts/codegen.ts      # same as chat's
  test/offline-demo.test.ts
  README.md               # the demo walkthrough script
```

## Schema

Both tables deliberately **unsharded** (no `shardKey`): client-supplied `mintId` ids are
v1-restricted to unsharded tables on the default ring (`docs/enduser/offline.md`, "v1
restrictions").

- `lists`: `{ name: v.string(), locked: v.boolean() }`
- `items`: `{ listId: v.id("lists"), label: v.string(), done: v.boolean() }`

## Functions

All declare `args` **and** `returns` validators so codegen types the optimistic store
(`OptimisticLocalStore.getQuery`/`setQuery` infer real row types).

- `lists.list({})` → all lists, `_creationTime` order.
- `lists.create({ _id: v.optional(v.string()), name })` → inserts, passing the client-minted `_id`
  straight through to `ctx.db.insert` (the documented worked-example shape; a caller that omits
  `_id` gets an engine-minted id).
- `lists.lock({ id })` → sets `locked: true`. This is the failure-demo trigger.
- `items.list({ listId })` → the list's items.
- `items.add({ _id: v.optional(v.string()), listId, label })` → **throws `ListLockedError`**
  (a demo-defined `UserError` subclass from `@stackbase/errors` with `code = "LIST_LOCKED"`) if the
  target list is locked. A `UserError` subclass is required — a plain `Error` carries no code on
  the wire and the drain would treat it as transient and retry it, by design.
- `items.toggle({ id, done })` → flips `done`.

## The wrapper transport (`web/offline-transport.ts`)

Implements the public `ClientTransport` interface; holds a real `webSocketTransport` inside.

- `setOffline(true)`: closes the inner transport (the client sees `onClose` and parks/queues into
  the outbox exactly as on a real network loss) and refuses to create a new one.
- `setOffline(false)`: constructs a fresh inner `webSocketTransport`, re-wires
  `onMessage`/`onClose` through, and fires the wrapper's `onReopen` listeners once the new socket
  opens — triggering the client's normal reconnect path (replay `SetAuth`, resubscribe, FIFO
  drain).
- The offline flag persists in `sessionStorage` (`packlist:offline`); at construction the wrapper
  starts offline if the flag is set, so **reload-while-offline stays offline**. *(post-review
  correction: sessionStorage — per-tab isolation keeps Flow 2 coherent; localStorage would force
  late-opened tabs offline)*
- Stable listener sets live on the wrapper (the client subscribes once, to the wrapper); inner
  transports come and go beneath them.

## Web app (`web/main.tsx`)

- Client construction:
  ```ts
  const transport = offlineToggleTransport(`${wsProtocol}://${location.host}/api/sync`);
  const client = new StackbaseClient(transport, {
    outbox: indexedDBOutbox(),
    optimisticUpdates: { /* registry: udfPath → updater, for lists.create, items.add, items.toggle, lists.lock */ },
    onMutationFailed: (info) => { /* surface into a toast/state — the tray shows the entry too */ },
  });
  ```
- The `optimisticUpdates` registry is the **same updater functions** the `useMutation(...)
  .withOptimisticUpdate(...)` call sites use — registered once at construction so entries queued
  before a reload render optimistically after it. Updaters read minted ids **from args** (the
  purity rule: never call `mintId()` inside an updater) and tolerate an `undefined` query baseline
  (offline-after-reload renders nothing until a baseline exists — the documented boundary).
- Header: app title and the **Go offline/online toggle**, which doubles as the connection badge
  (two states — offline/online, driven by the wrapper's own flag via a tiny
  `onStateChange(listener)`; `ClientTransport` deliberately has no socket-open introspection, and
  adding one is not this example's job).
- Layout: lists sidebar (create form + list rows with a lock button) and items panel for the
  selected list (add form, checkbox rows). Optimistic/pending rows get the same dimmed-row
  treatment as chat (`.pending`), using the documented pending-row type-widening recipe.
- **Pending tray**: a collapsible footer panel driven by `usePendingMutations()` — one row per
  durable entry showing function path, status (`unsent`/`inflight`/`failed`), `error.code` when
  failed, and `retry()`/`dismiss()` buttons on failed entries. `pendingSummary()` count badges the
  tray header.
- Selected-list state: when the selected list is itself a minted-id row not yet committed, the
  items panel still works — `items.list({listId})` subscribes (returns empty), and queued
  `items.add` rows render via the registry. This is the create-then-reference chain on screen.

## The demo script (README.md)

1. **The star flow:** run `bun run dev` → open the app → flip **Go offline** → create a new list
   and add several items into it (no awaits between them — the `mintId` chain) → **reload the
   page** (still offline: the queued rows re-render from the durable outbox via the registry;
   note honestly which parts render, per the offline-after-reload boundary) → flip **online** →
   watch the drain settle everything exactly-once with no flicker.
2. **Cross-tab:** open two tabs; writes (including queued-offline ones from the other tab) render
   live in both.
3. **Failure:** lock a list while online → go offline → queue adds into the locked list → go
   online → the adds terminally fail with `LIST_LOCKED`, visible in the tray with retry/dismiss.
4. **Prove it's real (optional):** the same flows with DevTools Network→Offline or by killing the
   dev server, with the caveat that reload-while-offline can't serve the page that way.

## Testing

- `test/offline-demo.test.ts` (vitest, embedded runtime — same harness style as chat's tests):
  - minted-id create-then-reference: `lists.create` with a supplied `_id`, then `items.add`
    referencing it, both commit and read back.
  - the locked rule: `items.add` into a locked list rejects with `code === "LIST_LOCKED"`.
- Typecheck (`tsc --noEmit`) wired as `build`/`typecheck` like the other examples; web bundle built
  by `web:build`.
- The heavy offline E2E (reload survival, drain, receipts, cross-tab) already lives in
  `packages/cli/test/outbox-e2e.test.ts` / `crosstab-e2e.test.ts` — the example's tests stay
  light and don't duplicate it.

## Non-goals

- No Service Worker / Background Sync (that's `drainOutboxOnce`'s recipe in the docs, not this
  demo).
- No changes to `@stackbase/client` or the engine.
- No persisted query baseline — the demo honestly shows the documented offline-after-reload
  boundary instead of papering over it.
