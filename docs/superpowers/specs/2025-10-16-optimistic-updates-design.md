# Client Optimistic Updates — the Gated Ledger

**Status:** approved design (brainstormed 2025-10-16; user delegated design calls)
**Design authority:** `docs/dev/research/client-sync/verdict.md` (542c7a0) — the adversarial-research
verdict IS the design. This spec scopes it into one slice, fixes the open questions the verdict
left to the spec, and states the task-facing requirements. Where this spec and the verdict's
§(b)-(f) differ in detail, the VERDICT governs; deviations require a documented decision here.
**Context shift since the verdict:** the durable offline outbox is the USER-COMMITTED NEXT slice
— the four seams are the first half of a two-slice plan; every seam decision below is checked
against the outbox's stated needs (verdict §(g) table).

## Goal

`useMutation(api.messages.send).withOptimisticUpdate((store, args) => …)` — Convex-verbatim
optimistic updates: instant UI, exact rollback (stop-replaying, no inverse ops), stacking,
no-flicker reconciliation (drop-on-observed-inclusion), deterministic `placeholderId()`/`now()`,
typed `OptimisticLocalStore` — over a client whose transport now reconnects by default. Plus the
four server repairs that make ANY optimistic client (ours or a future TanStack DB adapter) sound.

## Scope: one slice

The server repairs are prerequisites for the client work's own tests, fix two real shipped bugs
regardless (the G1 base-regression race; droppable mutation responses), and serve every future
client. Reconnect (T6) is the verdict's designated cut line if the slice runs long — cutting it
keeps the close rules and loses the flush path (re-scope S4 consciously if cut).

## The design (by reference + the fixed decisions)

### Client (verdict §(b)+(c) verbatim)

- **S1 `MutationLog`** — the `PendingMutation` record exactly as §(b) (the serializable triple
  `(requestId, udfPath, args)` + `seed` + `touched` + the three-state `status`).
- **S2 `LayeredQueryStore`** — `serverValue`/`composedValue` split; reference-inequality change
  detection; the cached first delivery serves the composed view.
- **S3 the reconcile chokepoint** — ONE function for server ingest / initiation / resolution /
  transport events; the gate predicate isolated as `versionCoversCommit(version, commitTs)`
  (v1: `commitTs <= maxObservedTs`, guarded `commitTs > 0`).
- **S4 `DeliveryPolicy`** — v1 rules = §(c) event 6 verbatim: at close, `unsent` retained;
  `inflight` rejects `MutationUndeliveredError` + layer drops; `completed` layers drop; NO layer
  crosses a session; `maxObservedTs` resets; on reconnect: SetAuth replay → resubscribe (the
  existing resync path) → FIFO flush of unsent.
- **The §(c) algorithm events 1–8 verbatim**, including: the atomic (b)+(c)+(d) reconcile pass
  (the no-flicker guarantee), replay-throw drops the entry and continues (never half-built),
  the 10s `gateTimeoutMs` valve, resync-in-session keeps layers, `client.query()` returns the
  composed view (D15), the `QueryFailed`-on-confirm residual documented (D16).
- **API surface** — §(b)'s v1 surface verbatim: `withOptimisticUpdate` (React + core
  `client.mutation(ref, args, { optimisticUpdate })`), typed `OptimisticLocalStore`
  (`getQuery`/`setQuery`/`getAllQueries`/`placeholderId`/`now`), dev-mode `Object.freeze` on
  `getQuery` results (dev builds only), `MutationUndeliveredError`. Rejected-from-v1 list per
  §(b) (no registry, no queue accessors, no optimistic actions ever).
- **Promise resolution at `MutationResponse`** (D3) — the documented divergence from convex-js,
  with the migration note verbatim in docs: "differs from Convex: `await` confirms commit, not
  local-cache inclusion."

### Server repairs (verdict §(d) — all four, priced as real work)

1. **W1:** `MutationResponse` success gains `ts` (protocol.ts:59; populated from the commitTs
   already destructured at handler.ts:209-210) + the send-site `commitTs > 0` assertion (dev
   throw / prod log) so the `runtime.ts:427` `?? 0n` fallback can never put a gate-breaking 0
   on the wire. Backward compatible.
2. **G4 origin-frontier guarantee** — the invariant verbatim: after a session's mutation
   commits, that session's `version.ts` advances to ≥ its commitTs, never before the session
   received every modification the commit implies. **Fixed decision (open question 1): the
   ephemeral origin tag is `origin?: string` (the sync session id)** threaded `executor.run`
   opts → transactor commitMeta (the plumbing exists) → `OplogDelta.origin` → `fanout.publish`
   → the subscribe payload → the drain queue entry → `notifyWrites(inv)`; `doNotifyWrites`
   emits the empty ts-advancing Transition when the origin session is absent from `bySession`.
   In-memory only — the tag is NEVER persisted (it must not enter commitMeta's guard-visible
   meta on the wire-to-store path; plan detail: carry it beside, not inside, the durable meta).
   Fleet-forward fallback per the verdict (tail-enqueued origin-check gated on the drain's
   last-processed commitTs). **The adapter-timing test on BOTH docstores is mandatory.**
3. **G1 serialization** — **fixed decision (open question 2): MQS processing enqueues onto the
   per-session notify tail** (ordering-by-construction; subscribe latency behind pending
   notifies is the accepted cost). The invariant: per-session monotone `serverValue`. A short
   spike confirms no deadlock with the existing tail (the fallback — tagged re-subscribe
   responses — only if the spike fails, documented).
4. **Backpressure exemption** — `MutationResponse`/`ActionResponse` are undroppable
   (session-controllers.ts:76-95); responses are small/rare/per-request.
- **Locked non-changes pinned by tests:** `excludeOriginFromTransition` stays off;
  response-before-Transition ordering gets the explicit real-server E2E (runtime.ts:455-458 is
  a comment-enforced accident today).

### Return-type codegen (D10 — in-slice prerequisite)

**Fixed decision (open question 3): inference from handler types as primary** — the generated
`api.d.ts` references the app modules' actual function types (the mechanism Convex's own
generated api uses), so `FunctionReturnType<typeof api.messages.list>` is the handler's real
return type with zero migrant burden; explicit `returns` validators (the argument-validation
machinery's sibling) are the ENHANCEMENT path, accepted when present, not required. Thread
`FunctionArgs`/`FunctionReturnType` generics through `OptimisticLocalStore`, `useQuery`,
`useMutation`. If inference proves infeasible against our codegen's module-analysis shape
(spec-review checks), fall back to `returns`-validators-primary with the migration cost stated.

### The outbox-alignment check (the next slice's receiving seams — verdict §(g) table)

S1 persists (IndexedDB) · S4 swaps fail-fast→park-and-resend · the registry-by-udfPath arrives
for reload replay · server dedup atomic with commit (the B3 fleet_idempotency relative) + poison
pill + session resume are the outbox slice's server bill. NOTHING in this slice's design may
close those doors; the plan's final review checks each seam against this table.
**Lunora input (user-flagged, confirmed by docs/dev/research/lunora.md §5):** the closest
competitor ships the full story via `clientId + monotone clientSeq` per-client watermarks
(`seq ≤ watermark` acked without re-running — ordered server dedup that also rejects
out-of-order) reconciled by `lastMutationId` — the Replicache-lmid family the verdict defers
behind the `versionCoversCommit` seam. Consequences bound HERE: (a) S1's `requestId` must not
preclude a monotone per-client sequence (the outbox slice decides clientSeq-vs-uuid; keep
requestId opaque-string so either fits); (b) the outbox slice evaluates Lunora's watermark
shape as its server-dedup design head-to-head with random-key fleet_idempotency; (c) the D12
revisit note gains Lunora as the third convergent lmid datapoint (with Replicache and Zero).

## Error handling (the verdict's §(c)/(f) rows govern)

| Failure | Behavior |
|---|---|
| Updater throws at initiation | Synchronous throw at call site; nothing sent |
| Updater throws during replay | Entry dropped + warn; rebuild continues (never half-built) |
| Mutation fails server-side | Reject promise; drop layer; full recompute (rollback = stop replaying) |
| Transport drops with in-flight mutations | `MutationUndeliveredError`; layers drop; unsent retained + flushed on reconnect |
| Gating frame lost / wrong guess | 10s gateTimeoutMs valve drops the layer + warns |
| `ts <= 0` leaks to the client | Warn + drop now (server assertion makes it unreachable) |
| Dropped MutationResponse under backpressure | Impossible (exemption) |
| Own write vanishes after gate (G1 race) | Impossible (MQS on the notify tail; monotone serverValue) |

## Testing (verdict §(h) mandated verbatim)

Loopback (real `StackbaseClient` over real `SyncProtocolHandler`): no-flicker ("no listener
frame ever shows the reverted state"), failure rollback, stacked A-fails-B-survives, temp-id
atomic swap, wrong-guess self-heal via the origin frontier, gate-timeout valve, resync-with-
pending-layers, drop-non-unsent-at-close, replay-throw containment, dev-freeze throw.
Real-WS E2Es (packages/cli/test, the action-e2e pattern): response-before-Transition pinned;
reconnect kill → resubscribe → unsent flush; backpressure response-exemption; **the G4
adapter-timing proof on BOTH SQLite and docstore-postgres**; **the D12 concurrent cross-shard
no-flicker test** (if it falsifies today's drain ordering, the server fix decision — ts-ordered
drain vs frontier-gated session ts — happens before ship, per the verdict).
Spikes before estimating (in the plan's T1): queryId reuse across a fresh session; origin-tag
plumbing depth through the fleet forward path.

## Docs

`docs/enduser/optimistic-updates.md`: the API, the purity rules (D11 — placeholderId/now
exclusively; randomUUID/Date.now the documented anti-pattern), temp-id constraints (no
placeholders in mutation args), the promise-timing migration note, the two documented residuals
(echo-snap on wrong guess; QueryFailed-on-confirm), the pending-row type-widening recipe, the
one-sentence useQuery-args-change scope exclusion. Chat example gains the optimistic send.
CLAUDE.md what-works entry. The client honestly-deferred note updates (optimistic shipped;
offline outbox = the committed next slice).
