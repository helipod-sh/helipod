# Browser UX Pair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Another tab's pending durable mutations render live as optimistic rows (dropping flicker-free on observed commit), and a Service Worker can drain the queue headlessly via `drainOutboxOnce` — closing the last two deferred rows of the offline story.

**Architecture:** Part A extends the hydrate-time layer machinery (`addHydratedEntry` — registry + persisted seed, already renders foreign entries at construction) to LIVE cross-tab events by making the existing BroadcastChannel payload additively typed (`enqueued`/`settled`/`failed`; legacy bare payloads keep nudging accessors). Part B refactors the private Connect-handshake helpers into a shared module and composes the already-exported `OutboxDrain` with a ~60-line store-only `DrainHost`.

**Tech Stack:** TypeScript; real `BroadcastChannel` (Node ≥ 18 global); fake-indexeddb for two-tab models; vitest under Node.

**Spec:** `docs/superpowers/specs/2025-11-28-browser-ux-pair-design.md` (approved; governs on conflict).

## Global Constraints

- The broadcast contract stays backward compatible: ANY message (including today's bare `1`) still fires every `outboxChangeListeners` callback; typed handling is IN ADDITION. Old tabs interop with new tabs losslessly (they just don't mirror).
- Own-tab discrimination: a `settled`/`failed` broadcast for an entry THIS tab initiated live is IGNORED (its own wire responses drive it). Mirrored entries are exactly those added via `addHydratedEntry`.
- The settled-drop path reuses the EXISTING gates: `onMutationSuccess(requestId, commitTs)` → completed → `versionCoversCommit` on this tab's own feed + the existing 10s gate timer. No new drop semantics.
- Missed-settle backstop: on an `enqueued` re-read, a mirrored durable entry absent from the fresh `loadAll()` with no settle received drops via `onVerdictAfterBaseline` (unconditional one-pass). Documented residual, not hidden.
- No new constructor option for cross-tab rendering (the registry is the consent; hydrate already renders foreign entries).
- `drainOutboxOnce` adds NO wire changes, NO retention, NO auth storage (`getAuthToken` is the app's SW-readable token, replayed as SetAuth before Connect). Lock-held by a live tab → immediate `{drained: 0, failed: 0, remaining}` (via `ifAvailable: true`).
- The handshake refactor is behavior-identical — all existing client tests pass UNCHANGED.
- Tests under Node (vitest); cross-package via built dist (`bun run build` first); full gate = `bun run build && bun run typecheck && bun run test`.
- Branch: `git checkout -b browser-ux main` before Task 1.
- Every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6`

## File Map

| File | Role |
|---|---|
| `packages/client/src/client.ts` | T1: typed broadcast post/receive + `mirrorFromStore`; T3: consume the extracted handshake module |
| `packages/client/src/connect-handshake.ts` | T3 NEW — extracted `sendConnect`/`outboxHeld`/`outboxAckedThrough` logic |
| `packages/client/src/headless-drain.ts` | T3 NEW — `drainOutboxOnce` + `HeadlessDrainOptions` + the store-only DrainHost |
| `packages/client/src/index.ts` | T3: export `drainOutboxOnce`, `HeadlessDrainOptions` |
| `packages/client/test/crosstab-render.test.ts` | T1 tests |
| `packages/client/test/headless-drain.test.ts` | T3 tests |
| `packages/cli/test/crosstab-e2e.test.ts` | T2 |
| `packages/cli/test/sw-drain-e2e.test.ts` | T4 |
| `docs/enduser/offline.md`, `CLAUDE.md` | T5 |

Order: T1 → T3 (both touch `client.ts` — serial) → {T2 ∥ T4} (disjoint cli test files; coordinator pre-builds dist once) → T5.

---

### Task 1: Cross-tab live rendering

**Files:** Modify `packages/client/src/client.ts` (broadcast receiver :330-334, post site :1382, drain-settle sites :1271-1291); Create `packages/client/test/crosstab-render.test.ts`.

**Interfaces produced (T2 relies on the behavior, not new API):** the typed broadcast payloads (internal):

```ts
type OutboxBroadcastMessage =
  | { kind: "enqueued" }
  | { kind: "settled"; clientId: string; seq: number; commitTs: number }
  | { kind: "failed"; clientId: string; seq: number; code?: string; message: string };
// Any OTHER payload (e.g. the legacy bare 1) = accessor nudge only — unchanged behavior.
```

- [ ] **Step 1: Read the anchors** — `client.ts:105-137` (broadcast seam), `:328-334` (receiver — fires ALL `outboxChangeListeners` on ANY message; KEEP that unconditional), `:1382` (post site), `:1204-1230` (`addHydratedEntry` — the mirroring workhorse: dedup by `(clientId, seq)`, registry lookup, `reconciler.addHydrated`), `:1271-1291` (drain settle sites), `reconcile.ts:90-95` (`onVerdictAfterBaseline`) and `:209-229` (`onMutationSuccess`). Also one fake-IDB + two-client harness precedent (`test/outbox-handshake.test.ts` / `outbox-e2e`-style construction).

- [ ] **Step 2: Failing tests** — `crosstab-render.test.ts`, two `StackbaseClient`s sharing one `IDBFactory` (fake-indexeddb) + real `BroadcastChannel` (Node ≥18 global), MockTransport per the harness precedent. Contract (each an `it`):
1. Tab A enqueues (durable) → tab B (registry configured with the same updater) renders the pending row in a subscribed query's composed value; the placeholder ids in A's and B's renders are EQUAL (deterministic seed replay).
2. Registry miss in B → no layer, accessor status only, exactly one console.warn.
3. Leader-settle: B receives `{kind:"settled", …, commitTs}` → B's layer becomes completed and drops ONLY when B's own feed observes `endVersion.ts >= commitTs` (assert still-rendered before, dropped after — the flicker-free gate).
4. `{kind:"failed"}` → B's mirrored entry marked failed; `onMutationFailed` fires in B (no live awaiter → the dev-loud default path also covered by spying console.error when no handler).
5. Own-tab ignore: a settled broadcast naming an entry A initiated live (A's own `pendingMutationCallbacks` has it) does NOT double-settle A.
6. Missed-settle backstop: delete the entry from the store directly (simulating a settle B never heard), post `{kind:"enqueued"}` → B's mirrored layer drops via the unconditional path.
7. Legacy compat: `postMessage(1)` still fires accessor listeners, mirrors nothing, throws nothing.
8. Memory-outbox client: no store, no mirroring, unaffected by broadcasts.

- [ ] **Step 3: Run to verify failure** — tab B renders nothing today (no typed handling exists).

- [ ] **Step 4: Implement in `client.ts`:**
- Post sites: the existing `:1382` nudge becomes `postMessage({kind: "enqueued"} satisfies OutboxBroadcastMessage)`; `drainSettleApplied` posts `{kind:"settled", clientId, seq, commitTs}` AFTER local settle (only when the entry carries clientId/seq — durable); `drainSettleTerminal` posts `{kind:"failed", …}` likewise.
- Receiver (`:330-334`): keep the unconditional accessor fan-out FIRST; then a typed dispatch: `enqueued` → `void this.mirrorFromStore()`; `settled`/`failed` → `this.onCrossTabSettle(msg)`. Wrap the typed path in try/catch routed to the R9 console floor (a malformed payload must never break the nudge contract).
- `private async mirrorFromStore()`: serialize on an in-flight flag (a second call while running sets a `rerun` bit, loops once more); `const {entries} = await this.outbox.loadAll()`; for each entry → `this.addHydratedEntry(e)` (its own dedup makes this idempotent); THEN the backstop: for each reconciler entry that is durable + mirrored (see discriminator below) whose `(clientId, seq)` is absent from the fresh snapshot and not own-live → `reconciler.onVerdictAfterBaseline(requestId)` … routed through the same `dropAfterBaseline` wrapper the verdict path uses (`client.ts:1128-1131`) so the baseline-pending machinery is respected.
- Own-live discriminator: mirrored entries are exactly those with no `pendingMutationCallbacks` entry for their `requestId` AND `durable` — verify against `addHydratedEntry`'s construction and add a targeted helper `private isMirroredEntry(entry): boolean` with a doc comment rather than inlining the predicate twice.
- `private onCrossTabSettle(msg)`: find the reconciler entry by `(clientId, seq)`; if absent or own-live → ignore; `settled` → `this.reconciler.onMutationSuccess(entry.requestId, msg.commitTs)`; `failed` → the existing terminal-settle helper shape (status failed + `notifyMutationFailed`), minus promise rejection (no promise exists for a mirror).

- [ ] **Step 5: Run** — new file green; FULL client suite green (the broadcast contract change must not disturb `usePendingMutations`/outbox tests); `bun run typecheck`.

- [ ] **Step 6: Commit** — `feat(client): cross-tab live optimistic rendering — typed broadcasts over the existing nudge channel`

---

### Task 2: Cross-tab E2E

**Files:** Create `packages/cli/test/crosstab-e2e.test.ts`.

- [ ] Read `packages/cli/test/outbox-e2e.test.ts` (server boot, nodeWsTransport, fake-IDB two-client pattern) first. Scenario per spec Testing §2: two real clients on one real dev server, shared fake-IDB factory + real BroadcastChannel, the same registry updater in both constructors; tab A offline-enqueues → assert tab B's subscribed composed value shows the pending row (bounded waitFor); reconnect A → the leader drains → assert B's layer drops exactly when B's own subscription delivers the committed row: sample B's rendered value continuously through the drop window and assert NO frame shows neither-pending-nor-committed and no frame shows both (the no-flicker contract); `pendingMutations()` empties in both tabs. 60s timeout. Run (dist pre-built), typecheck, commit `test(cli): cross-tab live rendering E2E — no-flicker drop through the real server`.

---

### Task 3: The headless drain (`drainOutboxOnce`)

**Files:** Create `packages/client/src/connect-handshake.ts`, `packages/client/src/headless-drain.ts`; Modify `client.ts` (consume the extracted module), `src/index.ts` (exports); Create `packages/client/test/headless-drain.test.ts`.

**Interfaces produced (T4 relies on):**

```ts
export interface HeadlessDrainOptions {
  url: string;
  outbox?: OutboxStorage;              // default indexedDBOutbox()
  deployment?: string;
  getAuthToken?: () => Promise<string | null>;
  poisonPolicy?: PoisonPolicy;         // default "skip"
  timeoutMs?: number;                  // default 30_000
  locks?: OutboxLockManager;           // injectable (tests; mirrors OutboxDrainOptions.locks)
}
export function drainOutboxOnce(opts: HeadlessDrainOptions):
  Promise<{ drained: number; failed: number; remaining: number }>;
```

- [ ] **Step 1 (refactor, behavior-identical):** extract `client.ts:937-977`'s Connect-message construction (`held` from drainable entries' `{clientId, seq}`, `ackedThrough` computation) into `src/connect-handshake.ts` (pure functions over `PendingMutation[]`/`OutboxEntry[]` + the wire types from `@stackbase/sync`); `StackbaseClient` consumes it. Run the FULL client suite — must pass UNCHANGED before proceeding. Commit separately: `refactor(client): extract the Connect-handshake helpers into a shared module`.
- [ ] **Step 2 (failing tests):** `headless-drain.test.ts` — store-only host settle mapping (applied → `dequeue`; terminal → `updateStatus("failed", {code, message})`); lock-held (injected fake `OutboxLockManager` whose `request` with `ifAvailable` yields null) → immediate `{drained: 0, failed: 0, remaining: N}`; `known:false` → unsent re-enqueued under a fresh clientId at the store level, parked → failed `OFFLINE_CLIENT_RESET`; `getAuthToken` → SetAuth frame precedes Connect (MockTransport frame order); `timeoutMs` → clean close + counts.
- [ ] **Step 3 (implement):** `src/headless-drain.ts` per the spec composition: `webSocketTransport(opts.url)` (or an injected transport for tests — accept an internal `_transport?` test seam if the file's tests need MockTransport; keep it underscore-internal), the ~60-line store-only `DrainHost` (all 14 members; `drainable()` mirrors `client.ts:1181-1195`'s filter/sort; `whenBaselineAdopted` resolved; `addHydrated` collects into the local drainable list), `new OutboxDrain(host, {lockName: <the client.ts:320 deployment-scoped name>, locks, poisonPolicy, …})`, drive one pass to quiescence or timeout, close, return counts. Export from `index.ts`.
- [ ] **Step 4:** run the new tests + FULL client suite + browser-clean dist guard + typecheck; `bun run build` at root.
- [ ] **Step 5: Commit** — `feat(client): drainOutboxOnce — headless one-shot outbox drain (the Background Sync seam)`

---

### Task 4: Headless drain E2E

**Files:** Create `packages/cli/test/sw-drain-e2e.test.ts`.

- [ ] Per spec Testing §4, mirroring the outbox E2E harness: seed 4 mutations via a normal client offline over a shared fake-IDB factory; `client.close()`; `drainOutboxOnce({url, outbox: indexedDBOutbox({indexedDB: idb})})` against the real server → exactly-once rows, `{drained: 4, failed: 0, remaining: 0}`; second call → `{drained: 0}` (receipts + empty queue); poison entry (a mutation that terminal-fails) → counted in `failed`, queue continues (`"skip"`); injected held lock → immediate no-op return. 60s timeout. Run (dist pre-built), typecheck, commit `test(cli): headless drain E2E — exactly-once through the real server`.

---

### Task 5: Docs + full gate

- [ ] `docs/enduser/offline.md`: rewrite the cross-tab paragraph (rendered rows live, registry prerequisite, missed-settle residual honestly noted); add "Draining after the tab closes (Chromium)" (the `sync`-event snippet calling `drainOutboxOnce` in `event.waitUntil`, ~76% support honesty, the SW-readable-token constraint, portable-baseline framing: Background Sync only improves WHEN the drain runs); graduate BOTH deferred rows (the table then holds only the declared non-goal).
- [ ] `CLAUDE.md`: extend the durable-offline entry (cross-tab live rendering via typed broadcasts + the registry; `drainOutboxOnce` SW seam).
- [ ] Full gate `bun run build && bun run typecheck && bun run test` → 64/64. Commit `docs: the browser UX pair — cross-tab rendering + the Background Sync recipe; offline deferrals emptied`.

---

## Self-review notes

Spec coverage: Part A table → T1 (all three message kinds + rules + backstop + no-option decision); ordering/purity → T1 test 1 (placeholder equality); Part B surface/composition/known:false/lock/timeout → T3; recipe → T5; Testing §1-4 → T1-T4; non-goals respected (no SharedWorker, no wire change, no auth storage — `getAuthToken` only). Type consistency: `OutboxBroadcastMessage` internal to client.ts; `HeadlessDrainOptions`/`drainOutboxOnce` consistent T3/T4. The handshake refactor is its own commit inside T3 so the reviewer can verify behavior-identity in isolation.
