# Pulse — the Stackbase optimistic-updates demo

A live poll board that exists to make optimistic updates *visible*. Optimistic UI is invisible
when it works — so this demo gives you a latency slider and an optimistic ON/OFF switch, and lets
you feel the difference yourself.

## Run it

From the repo root (once): `bun install && bun run build`. Then:

```bash
cd examples/optimistic-demo
bun run web:build   # bundle the SPA (web/main.js is gitignored)
bun run dev         # stackbase dev on http://localhost:3230
```

Open <http://localhost:3230>. Create a poll first (question + comma-separated options).

## Flow 1 — feel it

Set latency to **3s** (the slider injects delay into outbound *writes only* — a demo-local
transport wrapper, `web/delay-transport.ts`; subscriptions stay instant). Turn **optimistic OFF**.
Vote. Three painful seconds of nothing, then the count moves. Now flip **optimistic ON** and vote:
instant. Rapid-fire the button — the **"+N in flight"** chip counts your stacked optimistic
layers while the number climbs immediately. That stack is real: each click is its own pending
mutation replayed over the last, and each settles exactly-once in order.

## Flow 2 — rollback, exactly

Close a poll (🔒), keep some latency on, and vote anyway. The count bumps instantly (your
optimistic guess), then snaps back **exactly** to the pre-vote value when the server rejects it
with `POLL_CLOSED` (toast). Nothing else moves — rollback is stop-replaying-the-layer, never an
inverse write. Reopen the poll and the same button works again.

## Flow 3 — the honest one

Turn **wrong-guess mode** ON. Each vote now renders +2 instantly, and settles to +1 — the
documented echo-snap: your updater is a *guess*; the authoritative result always wins the same
frame it lands. This is the deepest rule of the whole system, visible in one glance.

## Flow 4 — two tabs

Open a second tab and vote in one. The other updates live (reactive subscriptions) — and note it
never sees your optimistic guesses, only committed truth. Optimistic layers are local by design.

## What this demo deliberately is NOT

No outbox, no offline toggle, no `mintId` — that's [`examples/offline-demo`](../offline-demo)'s
story (durability). Pulse isolates the pure online optimistic layer: `withOptimisticUpdate`,
`placeholderId` (the dimmed "creating…" poll card), stacking, and exact rollback.

## What to read next

- `docs/enduser/optimistic-updates.md` — the API, purity rules, and the two documented residuals.
- `web/delay-transport.ts` — the latency injector: FIFO-safe, mutations-only, on the public
  transport seam.
