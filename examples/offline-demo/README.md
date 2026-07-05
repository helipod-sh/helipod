# Packlist — the Helipod offline demo

A packing-list app that exists to make the durable offline sync story visible: the durable
outbox (queue → reload → drain → exactly-once), optimistic updates, client-minted ids
(create-then-reference with no awaits), the pending tray, cross-tab live rendering, and what a
conflict honestly looks like when the world changed while you were away.

## Run it

From the repo root (once): `bun install && bun run build`. Then:

```bash
cd examples/offline-demo
bun run web:build   # bundle the SPA (web/main.js is gitignored)
bun run dev         # helipod dev on http://localhost:3220
```

Open <http://localhost:3220>.

## Flow 1 — the star: offline → reload → drain, exactly-once

1. Flip **Go offline** (top right). The switch is a demo-local wrapper around the public
   `ClientTransport` seam (`web/offline-transport.ts`) and persists in sessionStorage — so a
   reload while offline STAYS offline (per-tab: going offline in one tab never forces a
   freshly-opened tab offline too).
2. Create a list, then add a few items into it. The list renders instantly (optimistic, dimmed
   while unconfirmed), and the **Outbox tray** at the bottom counts every queued mutation. The
   item rows themselves wait for reconnect: the brand-new list's items query has never been
   answered while offline, so there is no baseline for the optimistic rows to compose over — the
   documented honest boundary. (Add items to a list you opened while *online* — as in Flow 3 —
   and they render instantly too.) The list's id was minted client-side (`mintId("lists")`) so
   the item adds could reference it with no await — the create-then-reference chain, fully
   offline.
3. **Reload the page.** Still offline. The queued mutations are still in the tray (they live in
   IndexedDB). The panes render "waiting for first sync…" — after a reload there is no query
   baseline at all until the first reconnect, deliberately: there is no persisted query cache.
4. Flip **online**. Watch the tray drain FIFO and empty, and the list and its items appear
   authoritative — exactly-once (server receipts, not client hope).

## Flow 2 — two tabs

Open the app in a second tab. Everything renders live in both (reactive subscriptions), including
the other tab's still-queued offline writes (cross-tab optimistic rendering over BroadcastChannel).

## Flow 3 — the conflict, honestly

1. Create a list, keep it selected, and **lock** it (🔒 sets `locked: true` server-side).
2. Go offline and add items into it anyway. They queue and render dimmed — the client deliberately
   does NOT re-implement server rules; the handler is the single source of truth.
3. Reconnect. The adds drain, the server runs `items.add` against live state, and it throws
   `ListLockedError` — a typed, coded `UserError` subclass (`code: "LIST_LOCKED"`). Coded = the
   drain records it as a TERMINAL verdict (a plain `Error` would look like an infra hiccup and be
   retried). The tray shows the failed entry with **retry** / **dismiss**.

This is the whole conflict model: no merge, no CRDT — your mutation handler is the single source
of truth, and a queued write re-runs it against live state on drain.

## Flow 4 — prove it's real (optional)

Kill the dev server (Ctrl+C) instead of using the toggle: sends park, the tray holds. Restart it:
the client reconnects (backoff + jitter), resubscribes, and drains. (Reload-while-offline can't be
shown this way — the page itself needs the server — which is why the toggle exists.)

## What to read next

- `docs/enduser/offline.md` — the full model, conflict taxonomy, and honest boundaries.
- `docs/enduser/optimistic-updates.md` — updater purity rules and the pending-row recipe.
- `web/offline-transport.ts` — the toggle: ~130 commented lines on the public transport seam.
