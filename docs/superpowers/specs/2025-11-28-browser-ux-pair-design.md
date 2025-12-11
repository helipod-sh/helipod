# The Browser UX Pair — Cross-Tab Live Optimistic Rendering + the Background Sync Drain Seam

**Status:** approved design (2025-11-28; presented in-session, user delegated design calls)
**Parent:** the Receipted Outbox verdict §(i)'s last two open rows ("Cross-tab live optimistic
render | registry + shared store" and "Background Sync SW drain | drain-trigger seam") — offline
follow-on 4 of 4 approved 2025-11-04. Ground truth: the exploration fact sheet (session record);
key anchors cited inline.

## Part A — Cross-tab live optimistic rendering

### Goal

Another tab's pending durable mutations render as optimistic rows in THIS tab's queries (not just
`pendingMutations()` status), live, and drop flicker-free when the commit is observed — extending
the hydrate-time machinery (which already renders other SESSIONS' entries at construction) to live
cross-tab events.

### Why this is small: the machinery exists

`addHydratedEntry` (`client.ts:1204-1230`) already builds a layer for an entry this instance never
initiated: dedup by `(clientId, seq)`, fresh local `requestId`, the persisted `seed` verbatim
(deterministic `placeholderId`/`now` replay), `update` from the `optimisticUpdates` registry (miss
→ layerless + the existing one-warn), `reconciler.addHydrated` (throwing updaters are replay-drop
collateral, never rethrown). Today its only caller is the drain leader's once-guarded
`hydrateOnce()`. Part A adds live callers.

### The broadcast channel becomes additively typed

Today's message payload is deliberately meaningless (`postMessage(1)`; "the message IS the nudge",
`client.ts:1382`); every listener treats ANY message as a refresh nudge. That stays true — old
tabs are forward-compatible by construction. New payloads:

| Message | Posted by | On receipt (new behavior) |
|---|---|---|
| `{ kind: "enqueued" }` | any tab, after a durable append (the existing nudge site) | re-read `loadAll()`; `addHydratedEntry` every entry not in this tab's log (the existing `(clientId, seq)` dedup makes this idempotent) |
| `{ kind: "settled", clientId, seq, commitTs }` | the drain leader, at applied-settle | if this tab mirrors the entry: mark it `completed { commitTs }` → the EXISTING drop-on-observed-inclusion gate (`versionCoversCommit` on this tab's own feed + the existing gate timer) drops it flicker-free |
| `{ kind: "failed", clientId, seq, code?, message }` | the leader, at terminal-settle | if mirrored: mark failed (layer drops via the existing failed path; R9 observability fires — `onMutationFailed` with no live awaiter, the dev-loud default) |

Rules:
- The OWN-tab entry (the one whose `mutation()` promise lives here) is NEVER driven by broadcast —
  its wire responses drive it exactly as today; broadcast handling ignores `(clientId, seq)` pairs
  whose entry is not `durable`-mirrored (i.e. was initiated locally).
- Non-durable (memory-outbox) clients share nothing — no store, no rendering (unchanged).
- **Missed-message backstop:** on any `enqueued` re-read, a mirrored durable entry ABSENT from the
  store with no settle received drops via the unconditional one-pass path (`dropAfterBaseline`
  shape) — the rare double-render residual (drop before this tab's feed shows the row) is
  documented, not hidden; the settled-message path is the normal, flicker-free route.
- No new constructor option: a registry already consents to rendering foreign durable entries
  (hydrate does it today). Document that `optimisticUpdates` now also powers live cross-tab
  rendering; apps without a registry keep today's status-only behavior.

### Ordering & purity

Mirrored entries insert with `outboxOrderCounter` advancement exactly as hydrate does (FIFO by
persisted `order` across tabs). Replay purity holds by the same argument as hydrate: persisted
`args` + `seed`, registry updater, deterministic placeholders. `touched`-based recompose and the
byte-identity invariant (`layered-store.ts:218-226`) are unchanged.

### Correction (amended post-E2E 2025-11-28): the flicker-free claim, precisely

The design above states the settled-broadcast path drops flicker-free. That's true for the **DROP**
side (the mirrored layer never lingers once it's told to go), but Task 2's E2E
(`packages/cli/test/crosstab-e2e.test.ts`) against the real shipped mechanism found a genuine,
deterministic gap in the **APPEAR** side, reproduced 5/5 local runs — not a flaky race, and not
fixable without a `packages/client` change out of that task's scope:

- Tab B's own live `Transition` is a single server → B hop, fired by the *same* commit that produces
  tab A's applied verdict.
- Tab A's `settled` broadcast needs a full round trip (A → server → A) **plus** a local
  `BroadcastChannel` hop (A → B) before B's mirrored layer can be told to drop.
- Structurally, B's one-hop path beats A's round-trip-plus-broadcast path in essentially any real
  deployment, not just this test's localhost topology. So in the scenario Part A is built for — B
  already has a live subscription over the write A is draining — B's authoritative base value picks
  up the committed row **one frame before** either the `settled` broadcast or the
  `mirrorFromStore` backstop has run, producing exactly **one transient doubled frame** (committed
  row + still-active placeholder).

This doubled frame **self-heals** on the very next push — never permanent, never grows, never
oscillates — and the row is never *absent* at any point (no neither-pending-nor-committed gap).
That's the honest, verified guarantee Part A actually ships: flicker-**bounded**, not flicker-free,
for a cross-tab live observer.

For callers who need the **strict** no-double guarantee (zero tolerance, not "at most one transient
frame"), the fix is at the application layer, not the transport: write the registry's optimistic
updater as **idempotent**, keyed on a client-supplied id (`mintId`, see
`docs/enduser/offline.md#client-supplied-ids-create-then-reference-chains`) — the updater checks
whether a row with that id already exists in the query result and skips inserting a duplicate. The
placeholder row and the eventual committed row share the same id under `mintId` (minted client-side
before either mutation is sent, accepted verbatim by the engine), so an updater that recognizes an
already-present id and no-ops instead of re-inserting collapses the transient double to a single row
on every frame, including the one where both would otherwise be present. This isn't automatic — it's
an opt-in authoring discipline for apps that can't tolerate even one transient frame — but it's
sufficient, and it's the only sound fix that doesn't require changing the wire protocol or the
reconcile algorithm.

## Part B — `drainOutboxOnce`: the headless drain (the Background Sync seam)

### Goal

A Service Worker (or any UI-less context) can drain the durable queue: one exported function, no
`StackbaseClient`, no queries, no layers. Chromium's one-shot Background Sync then becomes a
documented recipe on top — a progressive enhancement on the drain trigger, NEVER the durability
story (verdict/e4 §2.4 verbatim framing).

### Surface

```ts
// @stackbase/client (core index — the bundle is already DOM-free and browser-clean)
export interface HeadlessDrainOptions {
  url: string;                                   // ws(s) sync endpoint
  outbox?: OutboxStorage;                        // default indexedDBOutbox() (IDB exists in SW)
  deployment?: string;
  /** SW-readable auth (research hazard #14: the app owns SW-readable token storage — we document
   *  the constraint, we do not build token storage). Replayed as SetAuth before Connect. */
  getAuthToken?: () => Promise<string | null>;
  poisonPolicy?: PoisonPolicy;                   // default "skip"
  timeoutMs?: number;                            // whole-drain budget, default 30_000
}
export function drainOutboxOnce(opts: HeadlessDrainOptions):
  Promise<{ drained: number; failed: number; remaining: number }>;
```

### Composition (from exported pieces; one refactor)

- `webSocketTransport(url)` — SW-compatible (global `WebSocket`; the transport has no DOM deps).
- **The one refactor:** the Connect-handshake helpers currently private in `client.ts:937-977`
  (`sendConnect` shape, `outboxHeld`, `outboxAckedThrough`) move to a shared internal module used
  by BOTH `StackbaseClient` and the headless drain — exported logic, never duplicated.
- A ~60-line store-only `DrainHost`: `drainable()` = the same filter/sort over `loadAll()`;
  `addHydrated` = collect into a local array (no log/store); `settleApplied` = `dequeue`;
  `settleTerminal` = `updateStatus("failed", …)`; `whenBaselineAdopted` = resolved (no live
  queries — matching `expectTransition=false` semantics); identity gate + poison policy carry
  over unchanged via `OutboxDrain` itself (already exported).
- `known:false` on ConnectAck in headless mode: unsent entries re-enqueue under a fresh clientId
  exactly as the client does; parked entries mark failed (`OFFLINE_CLIENT_RESET` code) — same
  verdict rules, store-level.
- Runs one drain pass until the queue is empty/terminal or `timeoutMs`, closes the socket,
  resolves with counts. Concurrent-tab safety: the same Web Locks leader lock name — if a live
  tab holds it, `drainOutboxOnce` returns `{drained: 0, …, remaining}` immediately (the tab is
  already draining; the SW's job is done).

### The docs recipe (not shipped code)

`docs/enduser/offline.md` gains a "Draining after the tab closes (Chromium)" section: the SW
`sync`-event registration snippet calling `drainOutboxOnce` inside `event.waitUntil`, the
Chromium-only honesty (~76%, Firefox/Safari never shipped it), the token-storage constraint, and
the framing: the portable baseline remains IDB queue + drain-on-next-visit; Background Sync only
improves WHEN the drain runs.

## Testing

Node ≥ 18 ships real `BroadcastChannel` and Web Locks are probe-guarded (single-tab fallback), so
two `StackbaseClient`s sharing one fake-indexeddb factory in one process is a faithful two-tab
model.

1. **Cross-tab units** (`packages/client/test/crosstab-render.test.ts`): enqueued-broadcast →
   mirrored layer renders in tab B (registry hit, deterministic placeholder equality with tab A's
   render); registry miss → status-only + one warn; settled-broadcast → completed + drops only
   when tab B's feed covers commitTs (flicker-free, the gate). failed-broadcast → R9 fires in B;
   own-tab entries ignore broadcasts; memory-outbox clients unaffected; missed-settle backstop
   drops on the next enqueued re-read; old-format message (bare `1`) still nudges accessors.
2. **Cross-tab E2E** (`packages/cli/test/crosstab-e2e.test.ts`): two real clients over one real
   server + shared fake-IDB + real BroadcastChannel; tab A enqueues offline → tab B renders the
   pending row live; tab A's leader drains on reconnect → tab B's layer drops exactly when B's own
   subscription shows the committed row. The literal, zero-tolerance "no frame shows both/neither"
   wording does NOT survive contact with the real mechanism (see the Correction above) — the
   assertion that actually holds, and is what this test enforces: the row is never *absent* once
   first rendered (no neither-pending-nor-committed gap), at most **one** transient doubled frame
   occurs and it self-corrects on the very next push (never permanent, never grows, never
   oscillates), and settlement is exact and stable thereafter; `pendingMutations()` empties in both.
3. **Headless drain units**: the store-only host's settle mapping; lock-held early return;
   known:false handling at the store level.
4. **Headless E2E** (`packages/cli/test/sw-drain-e2e.test.ts`): seed a queue via a normal client
   offline; close it; `drainOutboxOnce` against the real server → exactly-once commits, counts
   correct, receipts absorb a repeat call (idempotent second run: `{drained: 0}`); with a live
   tab holding the lock → immediate no-op return.
5. The SW `sync`-event wiring itself: browser-manual, documented as untested-in-CI.

## Non-goals

SharedWorker-owned sockets / a shared cross-tab socket; cross-tab sharing of non-durable
(memory-outbox) state; auth token storage (the app's job, constraint documented); periodic
Background Sync (only one-shot); non-Chromium background drain (portable baseline stays
drain-on-next-visit); any change to the wire protocol (this slice is client + docs only).

## Docs

`offline.md`: the cross-tab section rewritten (rendered rows now, not just status — with the
registry prerequisite and the missed-message residual honestly noted); the Background Sync recipe
section; BOTH remaining deferred-table rows graduate (the §(i) table empties of deferrals except
the declared non-goal). CLAUDE.md updated at merge.
