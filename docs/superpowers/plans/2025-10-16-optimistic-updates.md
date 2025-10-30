# Client Optimistic Updates Implementation Plan — the Gated Ledger

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convex-verbatim `withOptimisticUpdate` over the Gated Ledger (S1–S4), with the four server repairs that make any optimistic client sound, typed returns via `returns` validators, reconnect-by-default transport, and the verdict's mandated test battery.

**Architecture:** Spec = `docs/superpowers/specs/2025-10-16-optimistic-updates-design.md` (post-review e36be4f); design authority = `docs/dev/research/client-sync/verdict.md` §(b)-(h) VERBATIM (the spec scopes it; where a task needs algorithm detail, the verdict §(c) events 1–8 are the letter of the law). The spec-review corrections are binding: the G4 origin tag rides BESIDE commitMeta (`origin` on RunInTransactionOptions + OplogDelta, stamped after commitWrite, a NEW param chain at every hop), `returns`-validators are the v1 typing primary, G1's MQS unit reads session.version at EXECUTION time, G4 and G1 are separate tasks.

**Tech Stack:** TypeScript; loopback + real-WS tests; both docstores for the G4 proof.

## Global Constraints

- Exact values: `gateTimeoutMs` default **10_000**; dev-freeze in dev builds only; reconnect default-on with exponential backoff (`{ reconnect: false }` opt-out); query identity = the existing `path + ":" + JSON.stringify(argsJson)` hash (client.ts:63); `requestId` stays an opaque string (the outbox slice may choose monotone clientSeq — do not preclude).
- The §(c) algorithm events 1–8 are implemented VERBATIM (the plan quotes deltas only; implementers read the verdict §(c) directly — it is the requirements text).
- The verdict's locked non-changes pinned by tests: `excludeOriginFromTransition` stays off; response-before-Transition ordering gets a real-server E2E.
- Existing tests NEVER modified; apps not using optimistic updates are byte-identical (no updater registered = the composed view IS the server view by construction — prove via the untouched suites).
- Node/vitest; full gate = build && typecheck && test; commit trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6`

**Verified ground truth (verdict judging + spec review — do not re-derive):** `MutationResponse` lacks ts; `handleMutation` destructures commitTs and discards it (handler.ts:209-210); `runtime.ts:427` has the `?? 0n` fallback; the drain calls `notifyWrites(inv)` with NO origin (runtime.ts:480; adapter payload {tables,ranges,commitTs} at :656-663); `OplogDelta` (transactor types.ts:17-22) is constructed AFTER commitWrite returns (shard-writer.ts:364-369) — the beside-channel site; commitMeta is the guard-visible durable channel (types.ts:88-93) — the session id must NEVER enter it; the notify tail = handler.ts:242; MQS at handler.ts:179-202 reads session.version at :198-199 (execution-time — preserve); `execSub`→`runQuery` never re-enters the tail (deadlock-free); backpressure drops any frame type (session-controllers.ts:76-95); resubscribe preserves start.ts (handler.ts:198-200) — the F3 baseline; client cache single value slot (client.ts:26), cached first delivery (client.ts:75), mutation send (client.ts:108-114), Transition bracket check (client.ts:161-166), response handling (client.ts:169-177), close handler (client.ts:235-241), resync (client.ts:153-158, 220-233); `Mutation.requestId` echoed on both response variants (protocol.ts:46,59-60); `RegisteredFunction` erases Output (functions.ts:14-28); the analyzer reads runtime values (project.ts:90-99); `argsJson`→`validatorToTsType` precedent (project.ts:98); generate.ts:133 has the returnsType slot; react hooks (react.tsx:24-25 argsKey is an effect key, NOT store identity).

**DAG:** {T1 ∥ T3} → T2 → T4 → T5 → T6 → T7 → T8. (T1 = W1+backpressure (sync package) ∥ T3 = returns codegen (executor/codegen) — disjoint. T2 = G4+G1 (sync+runtime+transactor — needs T1's wire field for its tests). T4 = the ledger core (client). T5 = API+hooks. T6 = reconnect transport. T7 = E2E battery. T8 = docs.)

---

### Task 1 (parallel with T3): W1 + backpressure exemption

**Files:**
- Modify: `packages/sync/src/protocol.ts` (:59 success variant gains `ts: number`), `packages/sync/src/handler.ts` (:209-210 populate from the destructured commitTs + the send-site assertion: dev throw / prod console.error when `commitTs <= 0n`), `packages/sync/src/session-controllers.ts` (:76-95 — `MutationResponse`/`ActionResponse` frames are UNDROPPABLE)
- Test: extend packages/sync tests

**Interfaces (produced):** `MutationResponse` success = `{ type, requestId, success: true, value, ts: number }` — T4's gate consumes `ts`.

- [ ] **Step 1 (failing tests):** response carries ts = the mutation's commitTs (loopback through the real handler); the assertion fires on a forced 0 (stub) in dev-mode and logs in prod-mode; backpressure under a flooded session drops Transitions but NEVER responses (drive the controller directly per its existing tests + one integration).
- [ ] **Steps 2–5:** fail → implement → sync + cli + client suites green unmodified → full gate → commit `feat(sync): MutationResponse carries commitTs; responses undroppable`.

---

### Task 3 (parallel with T1): `returns` validators + typed codegen

**Files:**
- Modify: `packages/executor/src/functions.ts` (query/mutation/action accept `returns?: Validator` — stored as `returnsJson` in build(), mirroring argsJson; NO runtime enforcement this slice — typing only, enforcement noted as the argument-validation sibling follow-on), `packages/codegen`/`packages/cli` codegen (thread returnsJson → `validatorToTsType` → the generate.ts:133 returnsType slot; absent → `any` with the gap documented), `packages/client` types (`FunctionReturnType`/`FunctionArgs` generics exported for T5)
- Test: codegen tests (returns present/absent/complex validator → the emitted d.ts string), executor build() tests

- [ ] **Steps 1–5:** TDD → implement → codegen + executor suites + a regenerated example api.d.ts asserted → full gate → commit `feat(codegen): returns validators → typed FunctionReturnType`.

---

### Task 2: G4 origin-frontier + G1 MQS serialization (after T1)

**Files:**
- Modify: `packages/transactor/src/types.ts` (+`RunInTransactionOptions.origin?: string`; `OplogDelta.origin?: string`), `packages/transactor/src/shard-writer.ts` (stamp origin at oplog construction :364-369 — NEVER passed to commitWrite; both single + grouped paths), `packages/runtime-embedded/src/runtime.ts` (the origin chain: run opts → runInTransaction; the adapter payload + drain queue entry gain origin; `notifyWrites(inv)` receives it), `packages/sync/src/handler.ts` (runMutation passes its session id as origin; `doNotifyWrites` emits the empty ts-advancing Transition `{startVersion: session.version, endVersion: {querySet, ts: commitTs}, modifications: []}` when the origin session is absent from bySession; MQS processing enqueued on the per-session notify tail, reading session.version at EXECUTION time), fleet fallback (the tail-enqueued origin-check gated on the drain's last-processed commitTs for forwarded mutations that can't carry the tag — verify what /_fleet/run CAN carry first; if the origin can ride the forward body cleanly, prefer that and document)
- Test: sync + runtime-embedded + transactor extensions

**Interfaces (produced):** the origin chain; the empty-Transition emission — T4's wrong-guess self-heal and T7's adapter-timing proof consume them.

- [ ] **Step 1 (failing tests):** (a) the invariant: session commits a mutation touching NOTHING it subscribes to → the session still receives a ts-advancing empty Transition with endVersion.ts ≥ commitTs (loopback, real handler+runtime); (b) ordering: when the commit DOES modify subscriptions, the modifications arrive before-or-with the ts advance (never an empty advance first — by construction at the doNotifyWrites site; assert); (c) origin never reaches commitWrite's meta (spy on both stores); (d) grouped-commit path stamps per-unit origin correctly; (e) G1: a racing MQS + invalidation can no longer regress serverValue (construct the shipped race first — red — then serialize; per-session monotone serverValue asserted); (f) MQS bracket contiguity preserved (execution-time version read); (g) subscribe latency behind a pending notify is bounded-acceptable (no deadlock — the verified pure-read argument pinned by a test).
- [ ] **Steps 2–5:** fail → implement → sync + runtime-embedded + transactor + fleet suites → full gate → commit `feat(sync,runtime): the origin-frontier guarantee + MQS/notify serialization`.

---

### Task 4: The ledger core (S1–S4 + the §(c) algorithm)

**Files:**
- Create: `packages/client/src/mutation-log.ts` (S1 — the PendingMutation record verbatim from verdict §(b)), `packages/client/src/layered-store.ts` (S2), `packages/client/src/reconcile.ts` (S3 — ONE chokepoint + `versionCoversCommit`), `packages/client/src/delivery-policy.ts` (S4)
- Modify: `packages/client/src/client.ts` (the integration: initiation/Transition/response/close/resync all route through S3; the cached first delivery serves composed)
- Test: `packages/client/test/gated-ledger.test.ts` (loopback: REAL StackbaseClient over REAL SyncProtocolHandler — the verdict §(h) harness)

**Interfaces (consumed):** T1's ts, T2's empty Transition. **(produced):** `client.mutation(ref, args, { optimisticUpdate })`; the events 1–8 behavior T5/T7 build on.

- [ ] **Step 1 (failing tests — the verdict §(h) loopback list verbatim):** no-flicker (collect EVERY listener frame; assert none shows the reverted state across apply→confirm); failure rollback (reject + full recompute); stacked A-fails-B-survives; temp-id atomic swap (drop + authoritative ingest in ONE frame); wrong-guess self-heal via the origin frontier (updater writes a wrong prediction; the empty/covering Transition drops it; composed converges to server truth); gate-timeout valve (fake timer, 10s, warn + drop); resync-with-pending-layers (in-session: layers survive, rebuilt over the adopted baseline); drop-non-unsent-at-close (unsent retained, inflight rejects MutationUndeliveredError, completed drops); replay-throw containment (entry dropped + warn, rebuild completes); `ts <= 0` leak → warn + drop now; updater-throws-at-initiation → synchronous throw, nothing sent; client.query() returns composed (D15); events in requestId order; maxObservedTs resets at close.
- [ ] **Steps 2–5:** fail → implement → client suite + ALL existing suites unmodified green (the byte-identity proof) → full gate → commit `feat(client): the Gated Ledger — S1-S4 + the reconciliation algorithm`.

---

### Task 5: withOptimisticUpdate + typed OptimisticLocalStore + React hooks

**Files:**
- Create: `packages/client/src/optimistic-store.ts` (the OptimisticLocalStore view: getQuery/setQuery/getAllQueries over composed state, writes stack; `placeholderId(table)` deterministic per (entry, table, call-ordinal) from the entry seed; `now()` = seed.now; dev-freeze on getQuery results in dev builds)
- Modify: `packages/client/src/react.tsx` (`useMutation(...).withOptimisticUpdate(fn)` — Convex-verbatim chaining, stable across renders), `packages/client/src/index.ts` (exports + `MutationUndeliveredError`), thread T3's `FunctionReturnType`/`FunctionArgs` generics through store + hooks
- Test: extend gated-ledger tests + a react-level hook test (the existing react test harness pattern)

- [ ] **Step 1 (failing tests):** placeholderId determinism (same entry replayed → identical ids; two calls in one updater → distinct ordinals; different entries → different ids); now() stability across replays; dev-freeze throws on in-place mutation of a getQuery result (dev only); getAllQueries covers arg-families; withOptimisticUpdate chains + the updater runs before the wire send (spy ordering); typed store compiles against a returns-validator fixture (a type-level test via tsd-style expect-type or a compile fixture — say which).
- [ ] **Steps 2–5:** fail → implement → client suite → full gate → commit `feat(client): withOptimisticUpdate + typed OptimisticLocalStore + deterministic placeholders`.

---

### Task 6: Reconnect-by-default transport (the designated cut line)

**Files:**
- Modify: `packages/client/src/transport.ts` (or wherever webSocketTransport lives — reconnect + exponential backoff default-on, `{ reconnect: false }` opt-out), `packages/client/src/client.ts` (on reconnect: SetAuth replay (last token remembered) → resubscribe via the existing resync path → FIFO flush of unsent)
- Test: loopback-level reconnect simulation + the real-WS E2E lands in T7

- [ ] **Steps 1–5:** TDD (close → backoff schedule → reopen → SetAuth then resubscribe then flush, in that order — spy; unsent flushed FIFO; inflight rejected at close per S4; opt-out preserves today's terminal behavior) → implement → client suite → full gate → commit `feat(client): reconnect-by-default transport + unsent flush`.

---

### Task 7: The E2E battery (verdict §(h) real-WS mandates)

**Files:** `packages/cli/test/optimistic-e2e.test.ts` (the action-e2e pattern)

- [ ] **Step 1:** (1) response-before-Transition ordering pinned through the real server (the runtime.ts:455-458 comment becomes a test); (2) reconnect: kill the socket server-side → client resubscribes → unsent flushed → state converges; (3) backpressure response-exemption (flood a session; the mutation response still arrives); (4) **the G4 adapter-timing proof on BOTH SQLite and docstore-postgres** (the empty ts-advance arrives after-or-with the write's modifications on each store — the verdict's mandatory both-stores item); (5) **the D12 concurrent cross-shard no-flicker test** (8 shards, concurrent mutations on different shards from one client + a foreign client; assert drop-never-precedes-inclusion for the client's own writes; **if this falsifies today's drain ordering, STOP and surface — the server fix decision (ts-ordered drain vs frontier-gated session ts) is a controller/user gate per the verdict**); (6) the full optimistic chat flow (send with optimistic update → instant local echo → converges, no flicker frames — through the real dev server); existing scenarios byte-unmodified.
- [ ] **Step 2:** `bun run build`; green ×2; full monorepo gate (known flakes isolated-rerun, report). Commit `test(cli): optimistic updates E2E — ordering pins, G4 both stores, cross-shard no-flicker`.

---

### Task 8: Docs + finish

**Files:** `docs/enduser/optimistic-updates.md` (per the spec's Docs section verbatim: API, purity rules, temp-id constraints, the promise-timing migration note, the two residuals, the type-widening recipe, the scope-exclusion sentence), `examples/chat` gains the optimistic send, CLAUDE.md what-works, the client honestly-deferred note updated (optimistic shipped; offline outbox = the committed next slice with its research mandate). The (i)5 re-render measurement in the chat example (numbers in the report; structural sharing only if it measures hot — non-blocking).
- [ ] Docs + measurement → full gate → commit `docs(client): optimistic updates guide + chat example`.

## Execution notes

- Waves: **{T1 ∥ T3}** (worktrees: sync vs codegen — disjoint) → T2 (opus — the protocol chain) → T4 (opus — the algorithm core) → T5 (sonnet) → T6 (sonnet) → T7 (opus — the battery incl. the D12 gate) → T8 (sonnet). The soul constraint: no-updater apps byte-identical; existing tests never modified.
- T7's D12 test is the one place the plan can STOP for a decision (the verdict's pre-ship rule) — the implementer surfaces, never chooses the server fix alone.
