# `examples/optimistic-demo` ("Pulse") — design

**Date:** 2025-11-28
**Status:** Approved
**Goal:** A runnable example app that makes the shipped optimistic-updates story (the Gated
Ledger) *visible*: `withOptimisticUpdate` instant rendering, stacking under rapid fire, exact
rollback on a coded failure, `placeholderId` creation, the no-flicker settle — and, honestly, the
documented echo-snap residual (a deliberately wrong guess corrected by the server). Optimistic UI
is invisible when it works, so the demo's core device is a **latency slider** plus an
**optimistic ON/OFF switch**: you feel the difference yourself at every delay. The example is a
**pure consumer of shipped public APIs** — no engine or client-package changes. Deliberately
**outbox-free**: `examples/offline-demo` owns the durability story; this demo isolates the pure
online optimistic layer.

## Decisions taken (with the user, 2025-11-28)

1. **App shape: live poll / voting board** — vote counts are the most visceral way to feel
   instant-vs-waiting; rapid clicking shows stacking; a "voting closed" rule gives exact
   rollback; poll creation shows `placeholderId`.
2. **Latency device: slider + optimistic toggle** — a demo-local delaying transport wrapper
   (0ms / 250ms / 1s / 3s) plus an optimistic ON/OFF switch on the same mutation. Fixed-delay and
   side-by-side-panes variants were considered and rejected (can't dial; doubles the UI and
   muddies the shared store).
3. **Honesty demo: included** — a "wrong-guess mode" whose updater adds +2 while the server adds
   +1, so the settle visibly snaps to truth: the deepest rule (the server is always right; an
   updater is a guess) in one glance.
4. **Structure: sibling example** (Approach A) — mirrors `examples/offline-demo` file-for-file on
   **port 3230**; extending `examples/chat` or folding into offline-demo were rejected (pollutes
   the flagship / muddies two distinct stories).

## Structure

```
examples/optimistic-demo/
  package.json            # scripts: dev (port 3230), codegen, web:build, typecheck, test
  tsconfig.json
  # (no stackbase.config.ts — no components)
  convex/
    schema.ts             # polls, options
    polls.ts              # list, create, setClosed
    options.ts            # list, vote (+ PollClosedError)
    _generated/           # codegen output (committed)
  web/
    index.html
    main.tsx
    delay-transport.ts    # the latency-injecting ClientTransport wrapper
    main.js               # built bundle (gitignored)
  scripts/codegen.ts
  test/optimistic-demo.test.ts      # function unit tests (embedded runtime)
  test/delay-transport.test.ts      # wrapper unit tests (fake inner)
  test/optimistic-demo-e2e.test.ts  # the headline claims through the real dev server
  README.md
```

## Schema

- `polls`: `{ question: v.string(), closed: v.boolean() }`
- `options`: `{ pollId: v.id("polls"), label: v.string(), votes: v.number(), order: v.number() }`
  `.index("by_poll", ["pollId"])`
  *(post-review correction: same-transaction inserts share `_creationTime` and the index tiebreak
  is the random `_id`, so a poll's initial options need an explicit `order` ordinal for
  deterministic display — caught by Task 1's unit test)*

Counters live on option rows: each vote is a read-modify-write increment, so rapid fire shows
stacked optimistic layers as a climbing number. Both tables unsharded (no sharding story here;
keeps the example simple).

## Functions

All declare `args` and `returns` validators (typed optimistic store via codegen).

- `polls.list({})` → all polls (`by_creation`).
- `polls.create({ question, options: v.array(v.string()) })` → inserts the poll plus one option
  row per label (`votes: 0`) in one transaction (composite intent), returns the poll id.
- `polls.setClosed({ id, closed })` → sets `closed` — close AND reopen, so the rollback demo is
  repeatable without restarting.
- `options.list({ pollId })` → the poll's options (`by_poll`), sorted by `order`.
- `options.vote({ id })` → reads the option, reads its parent poll; **throws `PollClosedError`**
  (a demo-defined `UserError` subclass, `code = "POLL_CLOSED"`) when the poll is closed; else
  `replace` with `votes + 1`, returns the new count. With no outbox, an online mutation's failure
  rejects the promise and the optimistic layer is dropped — the exact-rollback demo.

## The delay transport (`web/delay-transport.ts`)

Implements the public `ClientTransport` interface; wraps a real `webSocketTransport` (injected
via a `makeInner` factory param defaulting to `webSocketTransport`, the same testable seam
`offline-demo`'s wrapper proved).

- `setDelay(ms)` / `getDelay()` — current artificial one-way delay for **outbound `Mutation`
  frames only** (`message.type === "Mutation"`, read structurally — no `@stackbase/sync` import).
  Everything else (subscriptions, `Connect`, auth, all inbound traffic) passes through untouched,
  so queries stay live and only *writes* feel the latency.
- Delayed frames go through a FIFO `setTimeout` queue — equal delays preserve send order, so
  mutation ordering is never perturbed (order matters to the engine).
- `close()` flushes nothing: pending delayed frames are dropped with the transport (matches a
  socket dying mid-flight; irrelevant in practice for a demo).
- Delay state is in-memory only (no persistence — reload resets to 0ms; there is no reload story
  in this demo).

## Web app (`web/main.tsx`)

- Client: `new StackbaseClient(delayTransport)` — **no outbox**, no registry; this demo is the
  pure online path.
- Header controls:
  - **Latency slider** — discrete stops 0 / 250ms / 1s / 3s → `transport.setDelay(ms)`.
  - **Optimistic switch (ON/OFF)** — the vote call site picks between two stable module-level
    callables: `useMutation(api.options.vote)` plain vs `.withOptimisticUpdate(voteOptimistic)`.
  - **Wrong-guess mode** — swaps `voteOptimistic` for `voteOptimisticWrong` (adds +2; the server
    adds +1). On settle the count visibly snaps down to truth — the echo-snap residual, on
    purpose.
- Poll cards: question, closed 🔒 badge with a close/reopen button, options with a vote button, a
  count, a CSS bar (width ∝ share of poll votes), and a **"+N in flight" chip** — an app-level
  counter (increment when a vote is sent, decrement when its promise settles) that makes stacking
  numeric. A rejected vote (`POLL_CLOSED`) surfaces as a transient toast; the bar's snap-back IS
  the rollback demo.
- New-poll form (question + comma-separated options): the optimistic updater inserts a pending
  poll row via `store.placeholderId("polls")` + `store.now()` (this demo's `placeholderId`
  showcase — deliberately different from offline-demo's `mintId`, which is an offline/outbox
  concern and out of scope here).
- Updaters follow the purity rules (module-scoped, ids/time from the store API, tolerate an
  `undefined` baseline) and the pending-row type-widening recipe for the dimmed pending poll row.

## Testing

- `test/optimistic-demo.test.ts` (embedded runtime): vote increments; `POLL_CLOSED` coded
  rejection; composite create (poll + N options in one transaction); reopen allows voting again;
  codegen drift check.
- `test/delay-transport.test.ts` (fake inner): only `Mutation` frames delayed (a `ModifyQuerySet`
  passes through immediately even at 3s); FIFO order preserved across delayed frames; `setDelay(0)`
  → pass-through; close drops pending frames without firing them late.
- `test/optimistic-demo-e2e.test.ts` (real dev server + real WebSocket client, the offline-demo
  E2E harness pattern): **the headline claim** — under an injected 500ms delay, a subscribed
  query's value reflects the optimistic vote *before* the mutation promise resolves (optimistic
  ON), and does NOT before the promise resolves with optimistic OFF; a vote into a closed poll
  rejects with `POLL_CLOSED` and the subscribed value ends at the pre-vote count (exact
  rollback).
- Port 3230; repo-wide build/typecheck/test must stay green; live smoke + browser hand-run of the
  README flows before merge (the offline-demo lesson: a demo's star flow is unverified until
  driven in a real browser).

## The demo script (README.md)

1. **Feel it:** latency to 3s, optimistic OFF → vote → three painful seconds of nothing → flip
   optimistic ON → vote → instant. Rapid-fire clicks → the "+N in flight" chip climbs (stacking)
   while counts move instantly.
2. **Rollback, exactly:** close a poll (🔒), set some latency, vote → the count bumps
   optimistically, then snaps back exactly when the server rejects with `POLL_CLOSED` (toast).
   Reopen and the same button works again.
3. **The honest one:** wrong-guess mode ON → each vote shows +2 instantly, settles to +1 — the
   server is always right; your updater is a guess.
4. **Reactive baseline:** two tabs — votes from one appear live in the other (and note the other
   tab never sees your optimistic guesses, only committed truth).

## Non-goals

- No outbox / durability / offline toggle (that's `examples/offline-demo`).
- No `mintId` (an offline create-then-reference concern; poll creation uses `placeholderId`).
- No changes to `@stackbase/client` or the engine.
- No delay on inbound frames or subscriptions (the demo isolates write-latency, which is where
  optimistic UI lives).
