# Action Runtime — design

**Status:** approved (brainstorming) — 2025-07-04
**Slice:** build-order #5 ("Actions + scheduled functions/crons"), **action half**. Sibling to the shipped `@stackbase/scheduler` (merge `5b806bd`). Makes `action` functions executable — the sanctioned escape hatch for side effects that run *outside* the transaction.
**Predecessor context:** The `action` function type exists (`packages/executor/src/functions.ts`), and `ACTION_PROFILE` already declares its capabilities (`dbRead:false, dbWrite:false, random/clock/network: native`), but `InlineUdfExecutor.run` throws on it (`"the inline executor does not yet run action functions (M5 scope)"`). The scheduler already routes `kind:"action"` jobs to a clean `unsupported` failure (`components/scheduler/src/driver.ts` ~line 132), waiting for this slice. HTTP `POST /api/run` already calls `runtime.run(path, args)` → `executor.run(fn)`, so it runs actions the moment the executor does. The sync protocol has a `Mutation` client message + `MutationResponse`, but **no `Action`**; the client SDK has `mutation()` but no `action()`. Queries/mutations run inside `transactor.runInTransaction`; actions must run entirely outside it. Reactivity, determinism, and the range-precise invalidation core all depend on queries/mutations staying pure — actions are the only non-deterministic surface.

---

## 1. Goal

Make `action` functions run: non-deterministic, native-capability (network/clock/random) TypeScript that executes **outside any transaction** and orchestrates the transactional core via `ctx.runQuery`/`runMutation`/`runAction`. Actions are callable from the scheduler (scheduled actions), from other functions (`ctx.runAction`), over the WebSocket from a client (`useAction`), and over HTTP (`/api/run`). This unlocks real apps: send email, call a third-party API, hit a webhook, run anything that can't live inside a deterministic transaction.

**The core invariant:** an action has **no `ctx.db`**. It touches data *only* through `ctx.runQuery`/`runMutation`, each a fresh top-level UDF running under its own deterministic profile. That structural indirection is what keeps the reactive/replayable core pure while quarantining the messy outside world to actions.

---

## 2. Locked decisions (from brainstorming)

1. **In-process execution.** The inline executor runs in-process (true V8-isolate global sandboxing is deferred per CLAUDE.md); a native-capability action fits that posture. No new runtime.
2. **`ActionCtx` = Convex's, exactly.** `runQuery`/`runMutation`/`runAction` + `ctx.scheduler` + `ctx.auth`/component facades + native `fetch`/`Date`/`Math.random`; **no `ctx.db`**.
3. **Client invocation is in scope** (the user chose the fuller slice): a one-shot `Action` WebSocket message + `ActionResponse` + client `action()`/`useAction`. Actions are **not reactive** — one-shot request→value, no subscription.
4. **Scheduled actions light up** by removing the scheduler driver's `unsupported` guard; the scheduler's at-most-once contract already fits.
5. **Deferred:** `httpAction` + the public HTTP router (external webhooks — a distinct routing subsystem); action timeouts / cancellation of a running action; streaming responses; per-action retry beyond the scheduler's.

---

## 3. Executor — the action execution path

`InlineUdfExecutor.run` branches on `fn.type`. Replace the `action` throw with a path that does **NOT** call `transactor.runInTransaction`:

- Run under `ACTION_PROFILE` (native network/clock/random; no db capabilities). Build an `ActionCtx` (§4). Invoke the handler; log via the existing `logSink` (kind `"action"`, with duration + ok/error). Return `{ value }`. **No read-set/write-set, no commit** — an action produces no reactive invalidation of its own.
- **The `invoke` seam (re-entrancy):** an action's `ctx.runQuery`/`runMutation`/`runAction` must resolve a function *path* → run it. The executor runs a given `fn` but does not resolve paths (that is the runtime's job — `runtime.run` does `this.modules[path]`). So the executor gains an injected **`invoke(path, args, opts) → Promise<UdfResult>`** (on `ExecutorDeps`, defaulting to a thrower if absent so non-action runtimes are unaffected). The runtime wires `invoke` to its own resolution + `executor.run`. Re-entrancy is safe: the action holds no transaction, so each nested `runMutation`/`runQuery` is a clean top-level transaction (no nesting, no lock re-entrancy).
- **`httpAction`** stays throwing this slice (deferred).

---

## 4. `ActionCtx` surface

Built for the action branch only (queries/mutations keep their existing ctx). Convex-parity:

```ts
interface ActionCtx {
  runQuery<T>(fnRef, args): Promise<T>;    // fresh read transaction, deterministic profile
  runMutation<T>(fnRef, args): Promise<T>; // fresh write transaction; its writes fan out reactively as normal
  runAction<T>(fnRef, args): Promise<T>;   // nested action, outside any transaction
  scheduler: { runAfter, runAt, cancel };  // scheduling from an action (see below)
  auth?: …;                                // identity + component facades that are valid outside a txn
  // native globals available in the handler: fetch, Date, Math.random (ACTION_PROFILE grants them)
  // NO db — structurally absent
}
```

- `runQuery`/`runMutation`/`runAction` accept a codegen `api.*`/`internal.*` ref or a string path (resolved via the existing `getFunctionPath` convention); they are **trusted server calls** — may reach `internal.*` and any namespace. Each routes through `invoke`.
- **`ctx.scheduler` in an action is non-transactional.** Convex semantics: with no surrounding txn, scheduling fires immediately. Implemented as a `runMutation` to the scheduler's enqueue module (so it commits its own job row in its own transaction). Exposed ergonomically as `ctx.scheduler.runAfter/runAt/cancel` but implemented on top of `runMutation` — no separate txn-bound scheduler facade in the action ctx.
- **Which facades appear:** `ctx.auth` (identity is available) and component facades whose operations make sense without a txn. Component facades that *require* a db writer (e.g. anything writing in-txn) are NOT exposed on the action ctx — the action uses `runMutation` for writes. (Concretely: the action ctx exposes identity + read-only/orchestration facades; DB mutation happens via `runMutation`.)

---

## 5. Scheduled actions

Remove the `unsupported` guard in `components/scheduler/src/driver.ts`. A claimed `kind:"action"` job dispatches to action execution through the driver's `runFunction` (which the runtime routes to `executor.run` of an action). Semantics already correct in the scheduler:

- **At-most-once:** the job commits `inProgress` *before* the action runs, so a crash mid-action leaves it `inProgress` → the lease sweep marks it `failed`, never re-running (you do not blind-retry a possibly-half-completed external side effect). This is the honest contract for actions and is already implemented.
- A **cleanly-returned** action failure follows the scheduler's retry/backoff (the action returned an error without partial external effect — safe to retry up to `maxFailures`). The scheduler's existing `_complete` failure path applies; the `TODO(action-slice)` marker left in `_complete` is resolved here by confirming this is the intended behavior (clean failure → retry; crash → at-most-once via lease, no retry of a possibly-partial run).
- `onComplete` fires on the action job's terminal transition exactly as for mutation jobs (already wired).

---

## 6. Client invocation (WebSocket + SDK)

Actions become callable straight from an app, one-shot (not reactive).

- **Protocol** (`packages/sync/src/protocol.ts`): add client `{ type: "Action"; requestId: string; udfPath: string; args: JSONValue }` and server `{ type: "ActionResponse"; requestId: string; success: true; value: JSONValue } | { type: "ActionResponse"; requestId: string; success: false; error: string }`.
- **Sync handler** (`packages/sync/src/handler.ts`): `handleAction` mirrors `handleMutation` — resolve identity, call `executor.runAction(udfPath, args, identity)`, reply `ActionResponse`. It does **NOT** call `notifyWrites`: the action itself writes nothing, and any mutation it invoked via `ctx.runMutation` already fanned out through that mutation's own commit. `SyncUdfExecutor` gains `runAction(udfPath, args, identity)`.
- **Client SDK** (`packages/client`): `client.action(ref, args): Promise<Value>` mirrors `mutation()` (send `Action`, resolve the `pendingActions` entry on `ActionResponse`, reject on `success:false` or connection close). A React `useAction(ref)` hook returns an async invoker (like `useMutation`), NOT a reactive value — actions have no subscription.
- **HTTP `/api/run`** already runs actions once the executor does (a free non-WebSocket fallback) — no change required; a test covers it.

---

## 7. Determinism & safety boundary

The profile system already enforces the split — this slice relies on it rather than adding new gates:
- `ACTION_PROFILE`: `network/clock/random: native`, `dbRead/dbWrite: false`. Because the action ctx has **no `ctx.db`**, an action cannot read or write data directly; the only data path is `runQuery`/`runMutation`, which run as normal UDFs under `QUERY_PROFILE`/`MUTATION_PROFILE`. So queries/mutations stay deterministic + replayable + reactive; actions are the sole non-deterministic surface and cannot pollute the core.
- **Errors:** a throw in the action handler (or in any nested `run*`) rejects the action's promise → `ActionResponse{success:false, error}` over WS, HTTP 500 over `/api/run`, or `failed` for a scheduled action. No partial-commit hazard (the action owns no transaction; each inner mutation is atomic on its own).
- **No new privilege surface:** actions are ordinary registered functions; client-invoked actions run under the session identity exactly like client-invoked mutations. `internal.*` actions are reachable from `ctx.run*` (server) but a client can only call functions it could already reach (same visibility rules as mutations — the `internal.*` visibility gap noted for the scheduler is orthogonal and not addressed here).

---

## 8. Testing

- **Executor action path:** an action runs outside a transaction with working native `fetch` (inject/stub a global `fetch`), `Date.now()`, `Math.random()`; it has NO `ctx.db`; `ctx.runQuery` returns committed data; `ctx.runMutation` commits AND its write reactively invalidates a subscribed query (proving the action→mutation→fan-out path); a nested `ctx.runAction` runs; a handler throw rejects with the error surfaced.
- **`ctx.scheduler` from an action:** `ctx.scheduler.runAfter(0, someMutation, …)` enqueues a job (via the under-the-hood runMutation) that the driver then runs.
- **Scheduled action (through the real driver):** `ctx.scheduler.runAfter(0, someAction, …)` → the action executes; a crash-mid-action (simulated `inProgress` + expired lease) → `failed`, not re-run (at-most-once); a cleanly-returned failure retries per backoff.
- **Client E2E (through the shipped `stackbase dev` server):** a client `action()` over the real WebSocket runs an action that calls `ctx.runMutation` to write a row; the call returns the action's value AND a separate live `useQuery` subscription receives the write — proving WS `Action` → executor → `runMutation` → reactive fan-out end-to-end in the shipped binary. Plus: a wrong/unknown action path → `ActionResponse{success:false}`.
- **HTTP fallback:** `POST /api/run` with an action path returns the action's value.
- **Regression:** existing query/mutation/executor/scheduler/sync/client/dashboard suites green; the scheduler's action-guard test is updated (an action job now runs instead of failing `unsupported`).

---

## 9. File structure

**Modify**
- `packages/executor/src/executor.ts` — the `action` branch (no `runInTransaction`; build `ActionCtx`; log); the `invoke` seam on `ExecutorDeps`/`RunOptions`.
- `packages/executor/src/guest.ts` — the `ActionCtx` type (+ export); ensure `action` functions type against it.
- `packages/runtime-embedded/src/runtime.ts` — public `runAction(path, args, opts)`; wire `invoke` to path resolution + `executor.run`; add `runAction` to the `SyncUdfExecutor` object.
- `packages/sync/src/protocol.ts` — `Action` client message + `ActionResponse` server message; `SyncUdfExecutor.runAction`.
- `packages/sync/src/handler.ts` — `handleAction` (mirror `handleMutation`, no `notifyWrites`).
- `packages/client/src/client.ts` — `action()` + `pendingActions` + `ActionResponse` handling + reject-on-close.
- `packages/client/src/react.ts` (or the hooks module) — `useAction`.
- `components/scheduler/src/driver.ts` — remove the `unsupported` action guard → dispatch action jobs.

**New**
- executor action tests (`packages/executor/test`), a scheduled-action test (`components/scheduler/test`), a client-action E2E (`packages/cli/test` or `packages/client/test`).

---

## 10. Out of scope (later slices)

`httpAction` + the public HTTP router (external webhooks / arbitrary HTTP endpoints — a routing subsystem with Request/Response objects, its own slice); action **timeouts** and cancellation of an in-flight action; **streaming** action responses; per-action retry policy beyond the scheduler's; the `internal.*` codegen typing gap (a scheduler follow-up, orthogonal); V8-isolate sandboxing of action code (engine-wide, deferred).
