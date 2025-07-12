# Action Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `action` functions executable — run outside any transaction with native capabilities (`fetch`/`Date`/`Math.random`) and NO `ctx.db`, orchestrating the transactional core via `ctx.runQuery`/`runMutation`/`runAction`; callable from the scheduler, other functions, the client (WebSocket `useAction`), and HTTP.

**Architecture:** `InlineUdfExecutor.run` gains an `action` branch that does NOT enter `transactor.runInTransaction`; it builds an `ActionCtx` and invokes the handler. `ctx.runQuery/runMutation/runAction` route through an injected `invoke(path, args, opts)` seam the runtime wires to its own resolution + `executor.run` (re-entrancy is safe — the action holds no txn, so each nested run is a clean top-level transaction). A mutation invoked from an action commits + fans out reactively through the normal path. `ctx.scheduler` in an action delegates to `ctx.runMutation` via a generic `ContextProvider.buildAction` seam. Client invocation adds a one-shot `Action`/`ActionResponse` WebSocket message pair (like `Mutation`, minus the reactive transition).

**Tech Stack:** TypeScript, Bun, Turborepo, vitest. Builds on the executor (`InlineUdfExecutor`, `ExecutorDeps`, `RunOptions`, `ACTION_PROFILE`), the runtime (`EmbeddedRuntime`, `SyncUdfExecutor`, path resolution), the sync protocol/handler + client (mirror the `Mutation` path), and `@stackbase/scheduler` (the `driver.ts` action guard, the enqueue facade).

## Global Constraints

- **Bun toolchain:** `bun run build`, `bun run typecheck`, `bun run test`; single pkg `bun run --filter <pkg> test`. Never pnpm/npm.
- **The core invariant:** an action has **NO `ctx.db`** (structurally absent). Data access is ONLY via `ctx.runQuery`/`runMutation`/`runAction`, each a fresh top-level UDF under its own profile. This is what keeps the reactive/deterministic core pure.
- **Actions run OUTSIDE `transactor.runInTransaction`** — no read-set/write-set, no commit, no reactive invalidation of their own. `ACTION_PROFILE` (`dbRead:false, dbWrite:false, network/clock/random: native`) already declares this.
- **`invoke` is trusted server re-entrancy** — it resolves ANY registered path including `_`-prefixed (unlike the public `run`, which blocks `_`). Client `Action` invocation uses the public `run`-style path gate (cannot call `_`).
- **Convex parity:** `ctx.runQuery/runMutation/runAction` + `ctx.scheduler.runAfter/runAt/cancel` + native globals; client `action(ref, args): Promise<Value>` + `useAction`. Actions are NOT reactive (one-shot request→value).
- **Delivery:** a scheduled action is **at-most-once** (the scheduler commits `inProgress` before running → crash mid-action → `failed`, never re-run — already implemented); a cleanly-returned action failure retries per the scheduler's backoff.
- **Test through the shipped entrypoint:** the client-action feature gets an E2E through the real `stackbase dev` server (a client `action()` over the real WebSocket whose inner `runMutation` live-updates a separate subscription) — mechanism tests alone have twice missed shipped-server wiring gaps this project.
- **Deferred (do NOT build):** `httpAction` + the public HTTP router; action timeouts/cancellation; streaming responses.
- TDD, frequent commits, each task ends green (`build`/`typecheck`/`test`). `noUncheckedIndexedAccess: true`.

Backing detail: `docs/superpowers/specs/2025-07-04-action-runtime-design.md`.

---

## File Structure

- `packages/executor/src/executor.ts` (**modify**) — the `action` branch; `ExecutorDeps.invoke`; build the `ActionCtx`.
- `packages/executor/src/guest.ts` (**modify**) — the `ActionCtx` type.
- `packages/executor/src/context-provider.ts` (or wherever `ContextProvider` is defined — **modify**) — optional `buildAction`.
- `packages/runtime-embedded/src/runtime.ts` (**modify**) — wire `invoke`; public `runAction`; `SyncUdfExecutor.runAction`.
- `components/scheduler/src/{index,facade,modules}.ts` (**modify**) — `buildAction` scheduler facade + internal `_enqueue`/`_cancel` mutations.
- `components/scheduler/src/driver.ts` (**modify**) — remove the `unsupported` action guard.
- `packages/sync/src/{protocol,handler}.ts` (**modify**) — `Action`/`ActionResponse` + `handleAction` + `SyncUdfExecutor.runAction`.
- `packages/client/src/{client,react}.ts` (**modify**) — `action()` + `useAction`.
- Tests: `packages/executor/test`, `components/scheduler/test`, `packages/sync/test`, `packages/cli/test` (E2E).

---

## Task 1: Executor action path + `invoke` seam + `ActionCtx`

**Files:**
- Modify: `packages/executor/src/executor.ts`, `packages/executor/src/guest.ts`
- Modify: `packages/runtime-embedded/src/runtime.ts`
- Test: `packages/executor/test/action-run.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // guest.ts
  export interface ActionCtx {
    runQuery<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
    runMutation<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
    runAction<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
    // scheduler + component facades added in Task 2; identity available; native fetch/Date/Math.random
  }
  // executor.ts — ExecutorDeps gains:
  //   invoke?: (path: string, args: JSONValue, opts?: { identity?: string | null }) => Promise<UdfResult>;
  // runtime.ts — public:
  //   async runAction<T>(path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult<T>>
  ```
- Consumes: `ACTION_PROFILE` (`profileFor("action")`), the `logSink`, `getFunctionPath` (from `@stackbase/client`'s api module or replicate the ~5-line resolver locally to avoid a client dep — a ref carries its path).

- [ ] **Step 1: Write the failing test**

`packages/executor/test/action-run.test.ts` — mirror `packages/executor/test/row-policy.test.ts`'s harness (InlineUdfExecutor + a store), but drive actions through a runtime so `invoke` is wired. Simplest: use `EmbeddedRuntime` like `packages/admin/test/browse-live.test.ts` and call `runtime.runAction`.

```ts
import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { query, mutation, action } from "@stackbase/executor";

async function makeRuntime(modules: Record<string, any>) {
  const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: modules }, []);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
    tableNumbers: c.tableNumbers,
  });
}

describe("action execution", () => {
  it("runs an action outside a txn; ctx.runMutation commits; ctx.runQuery reads it back; native globals work; NO ctx.db", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:list": query(async (ctx: any) => (await ctx.db.query("notes").collect()).map((d: any) => d.body)),
      "app:act": action(async (ctx: any, a: { body: string }) => {
        expect((ctx as any).db).toBeUndefined();               // core invariant: no db
        const rnd = Math.random(); const t = Date.now();        // native globals available
        await ctx.runMutation("app:add", { body: a.body });     // fresh write txn
        const list = await ctx.runQuery("app:list", {});        // fresh read txn, sees the write
        return { list, hadRandom: typeof rnd === "number", hadClock: typeof t === "number" };
      }),
    });
    const res = await r.runAction("app:act", { body: "hello" });
    expect((res.value as any).list).toEqual(["hello"]);
    expect((res.value as any).hadRandom && (res.value as any).hadClock).toBe(true);
  });

  it("a nested ctx.runAction runs; a handler throw rejects with the error", async () => {
    const r = await makeRuntime({
      "app:inner": action(async () => 42),
      "app:outer": action(async (ctx: any) => await ctx.runAction("app:inner", {})),
      "app:boom": action(async () => { throw new Error("kaboom"); }),
    });
    expect((await r.runAction("app:outer", {})).value).toBe(42);
    await expect(r.runAction("app:boom", {})).rejects.toThrow(/kaboom/);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/executor test action-run`
Expected: FAIL — `runtime.runAction` undefined / the executor throws `"does not yet run action functions"`.

- [ ] **Step 3: Add the `ActionCtx` type (`guest.ts`)**

Add the `ActionCtx` interface (above). Import `FunctionReference` from wherever the codegen ref type lives (grep `FunctionReference`); if it's only in `@stackbase/client`, use `FunctionReference | string` with a local structural type to avoid a dep cycle.

- [ ] **Step 4: Add the `invoke` seam + action branch (`executor.ts`)**

Add `invoke?: (path: string, args: JSONValue, opts?: { identity?: string | null }) => Promise<UdfResult>;` to `ExecutorDeps`. Replace the `action` throw with a branch (keep `httpAction` throwing):

```ts
    if (fn.type === "httpAction") throw new Error("the inline executor does not yet run httpAction functions");
    if (fn.type === "action") return this.runActionFn<T>(fn, args, options);
```

Add the method (no `runInTransaction`):

```ts
  private async runActionFn<T>(fn: RegisteredFunction, args: unknown, options: RunOptions): Promise<UdfResult<T>> {
    const clock = this.deps.now ?? Date.now;
    const startedAt = clock();
    const invoke = this.deps.invoke;
    if (!invoke) throw new Error("action execution requires an `invoke` runner (runtime wiring missing)");
    const run = (kind: "query" | "mutation" | "action") =>
      async (ref: unknown, a: Record<string, unknown> = {}) => {
        const path = resolveRef(ref);
        const res = await invoke(path, convexToJson(jsonToConvex(a) as Value) as JSONValue, { identity: options.identity ?? null });
        return res.value;
      };
    const actionCtx: Record<string, unknown> = {
      runQuery: run("query"), runMutation: run("mutation"), runAction: run("action"),
      // Task 2 augments actionCtx with scheduler + component facades before the handler runs.
    };
    try {
      const value = await fn.handler(actionCtx, args);
      this.deps.logSink?.push({ path: options.path ?? "<anonymous>", kind: "action", ts: startedAt, durationMs: clock() - startedAt, status: "ok" });
      return { value: value as T, readRanges: [], oplog: undefined } as unknown as UdfResult<T>;
    } catch (e) {
      this.deps.logSink?.push({ path: options.path ?? "<anonymous>", kind: "action", ts: startedAt, durationMs: clock() - startedAt, status: "error", error: String(e) });
      throw e;
    }
  }
```

> `resolveRef(ref)` = `typeof ref === "string" ? ref : getFunctionPath(ref)` — a tiny local helper (a ref carries its `_path`/path; replicate `packages/client/src/api.ts:getFunctionPath`'s logic to avoid depending on the client package). Match the real `UdfResult` shape — grep its definition and return the minimal valid object for an action (no oplog/readRanges); if `UdfResult` requires fields, provide empty/undefined ones. The `convexToJson(jsonToConvex(...))` round-trip normalizes args to JSON for `invoke`; if `invoke` already takes a JS object, pass `a` directly — match `invoke`'s real signature you define.

- [ ] **Step 5: Wire `invoke` + `runAction` in the runtime (`runtime.ts`)**

The executor is built before the runtime object exists → use a `let` closure to break the cycle. Near the executor construction:

```ts
    let executorRef: InlineUdfExecutor;
    const invoke = async (path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult> => {
      const fn = modules[path];                                  // NO `_`-prefix block — trusted server re-entrancy
      if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
      return executorRef.run(fn, jsonToConvex(args), {
        path, namespace: namespaceForPath(path, componentNames),
        contextProviders, policyRegistry, policyProviders, relationRegistry,
        identity: opts?.identity ?? null,
      });
    };
    const executor = new InlineUdfExecutor({ transactor, queryRuntime, catalog: options.catalog, logSink: options.logSink, now: options.now, invoke });
    executorRef = executor;
```

(`modules` is the mutable map the runtime already holds; `contextProviders` etc. are the same values passed to `run`. Confirm they're in scope at this point — if some are computed later, move the `invoke` closure after they're defined, or have it read them from `this`/closure vars.) Add the public method:

```ts
  async runAction<T = unknown>(path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult<T>> {
    if (path.startsWith("_")) throw new FunctionNotFoundError(`unknown function: ${path}`);   // public gate
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    if (fn.type !== "action") throw new Error(`${path} is not an action`);
    return this.executor.run<T>(fn, jsonToConvex(args), { path, namespace: namespaceForPath(path, this.componentNames), contextProviders: this.contextProviders, policyRegistry: this.policyRegistry, policyProviders: this.policyProviders, relationRegistry: this.relationRegistry, identity: opts?.identity ?? null });
  }
```

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/executor test action-run`
Expected: PASS (action runs; runMutation commits + runQuery reads it; no db; nested action; throw rejects).

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (additive: `invoke` optional; non-action runtimes unaffected; queries/mutations unchanged).

```bash
git add packages/executor/src/executor.ts packages/executor/src/guest.ts packages/runtime-embedded/src/runtime.ts packages/executor/test/action-run.test.ts
git commit -m "feat(executor): action execution path — runs outside a txn, ctx.runQuery/runMutation/runAction via the invoke seam"
```

---

## Task 2: `ctx.scheduler` (+ component facades) in actions via `buildAction`

**Files:**
- Modify: the `ContextProvider` type (grep `interface ContextProvider` — likely `packages/executor/src/*.ts`), `packages/executor/src/executor.ts` (build action-mode facades)
- Modify: `components/scheduler/src/{index,facade,modules}.ts`
- Test: `components/scheduler/test/action-scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1's `ActionCtx` (`runQuery`/`runMutation`).
- Produces:
  ```ts
  // ContextProvider gains (optional):
  //   buildAction?(api: { runQuery, runMutation, runAction, identity: string | null }): object;
  // scheduler component: internal mutations scheduler:_enqueue / scheduler:_cancel (mutations),
  //   and buildAction returning { runAfter, runAt, cancel } delegating to api.runMutation of those.
  // Result: inside an action, ctx.scheduler.runAfter(ref, args, delayMs) enqueues a job.
  ```

- [ ] **Step 1: Write the failing test**

`components/scheduler/test/action-scheduler.test.ts` — compose the scheduler + an action that schedules a mutation; assert the scheduled mutation runs. Reuse `components/scheduler/test/helpers.ts`'s `makeRuntimeWithScheduler` (extend it to register app actions + return `{runtime, tick}`).

```ts
it("ctx.scheduler.runAfter from an action enqueues a job that the driver then runs", async () => {
  const ran: string[] = [];
  const { runtime, tick } = await makeRuntimeWithScheduler({
    "app:work": mutation(async (_c: any, a: { tag: string }) => { ran.push(a.tag); return null; }),
    "app:act": action(async (ctx: any) => { await ctx.scheduler.runAfter(0, "app:work", { tag: "from-action" }); return "ok"; }),
  });
  expect((await runtime.runAction("app:act", {})).value).toBe("ok");
  await tick();
  expect(ran).toEqual(["from-action"]);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/scheduler test action-scheduler`
Expected: FAIL — `ctx.scheduler` undefined in the action ctx.

- [ ] **Step 3: Add `buildAction` to `ContextProvider` + build it in the executor**

Add optional `buildAction?(api: { runQuery: Fn; runMutation: Fn; runAction: Fn; identity: string | null }): object;` to `ContextProvider`. In `executor.ts runActionFn`, after building `runQuery/runMutation/runAction`, loop the `options.contextProviders` and for each with a `buildAction`, attach `actionCtx[p.name] = Object.freeze(p.buildAction({ runQuery, runMutation, runAction, identity: options.identity ?? null }))`. (Reserved-name collision check like the mutation path.)

- [ ] **Step 4: Scheduler internal enqueue/cancel mutations (`components/scheduler/src/modules.ts`)**

Add two internal (`_`-prefixed, so not client-callable; reachable via `invoke`) mutations:
```ts
// _enqueue: schedule a function at an absolute time (ms). Delegates to the in-txn facade.
"scheduler:_enqueue": mutation(async (ctx: any, a: { fnPath: string; args: JSONValue; runAtMs: number }) =>
  ctx.scheduler.runAt(a.runAtMs, a.fnPath, a.args)),
"scheduler:_cancel": mutation(async (ctx: any, a: { id: string }) => { await ctx.scheduler.cancel(a.id); return null; }),
```
(These run in a mutation, so `ctx.scheduler` is the normal in-txn facade. Register them in `defineScheduler()`'s modules map.)

- [ ] **Step 5: Scheduler `buildAction` (`components/scheduler/src/index.ts` / a facade module)**

In `defineScheduler()`, add `buildAction` to the scheduler's context provider:
```ts
buildAction: (api) => ({
  runAfter: (ref: unknown, args: unknown, /* Convex order: (delayMs, ref, args) — MATCH the mutation facade signature */) => {/* see note */},
  ...
}),
```
> **Signature note:** match the EXISTING `ctx.scheduler.runAfter` signature from the mutation facade (Task 2 of the scheduler slice — check `components/scheduler/src/facade.ts`: it's `runAfter(delayMs, fnRef, args)`). The action `buildAction` version must expose the IDENTICAL signature so a function body is portable between mutation and action. Implement it as: `runAfter: (delayMs, ref, args) => api.runMutation("scheduler:_enqueue", { fnPath: resolveRef(ref), args, runAtMs: Date.now() + delayMs })`, `runAt: (ts, ref, args) => api.runMutation("scheduler:_enqueue", { fnPath: resolveRef(ref), args, runAtMs: (ts instanceof Date ? ts.getTime() : ts) })`, `cancel: (id) => api.runMutation("scheduler:_cancel", { id })`. (`Date.now()` here is fine — an action is non-deterministic; the scheduler recomputes nothing from it.)

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/scheduler test action-scheduler`
Expected: PASS.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (additive: `buildAction` optional; components without it just don't appear on the action ctx).

```bash
git add packages/executor/src components/scheduler/src components/scheduler/test/action-scheduler.test.ts
git commit -m "feat(actions): ctx.scheduler in actions via ContextProvider.buildAction (delegates to runMutation)"
```

---

## Task 3: Scheduled actions execute (remove the driver guard)

**Files:**
- Modify: `components/scheduler/src/driver.ts`
- Test: `components/scheduler/test/dispatch.test.ts` (update the action-guard test) or a new `components/scheduler/test/scheduled-action.test.ts`

**Interfaces:**
- Consumes: Task 1's action execution (the driver's `runFunction` routes through the runtime → `executor.run` of an action).

- [ ] **Step 1: Write the failing test**

Update the existing action-guard assertion (it currently expects a `kind:"action"` job to fail `unsupported`) and add real execution in `components/scheduler/test/scheduled-action.test.ts`:

```ts
it("a scheduled action runs (not unsupported)", async () => {
  const ran: string[] = [];
  const { runtime, tick } = await makeRuntimeWithScheduler({
    "app:sendish": action(async (_c: any, a: { to: string }) => { ran.push(a.to); return null; }),
    "app:sched": mutation(async (ctx: any) => { await ctx.scheduler.runAfter(0, "app:sendish", { to: "x@y.z" }); return null; }),
  });
  await runtime.run("app:sched", {});
  await tick();
  expect(ran).toEqual(["x@y.z"]);
});

it("a crash mid-action (inProgress + expired lease) is at-most-once — failed, not re-run", async () => {
  // craft via _system:insertJob a kind:"action" job left inProgress with expired lease; run _reclaim; assert state==="failed" and the action did NOT run.
});
```

Find the CURRENT dispatch test that asserts the `unsupported` action failure (grep `unsupported` in `components/scheduler/test`) and change it: an action job now RUNS. If that test crafted an action job specifically to prove the guard, repurpose it to prove execution.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/scheduler test scheduled-action`
Expected: FAIL — the driver still fails action jobs `unsupported`.

- [ ] **Step 3: Remove the guard (`driver.ts`)**

Find the `if (claimed.kind === "action")` block (~line 132) that `_complete`s the job as `unsupported`. Remove it so an action job falls through to the same `runFunction(claimed.fnPath, claimed.args)` path as a mutation job. (The runtime routes an action fn to `executor.run`'s action branch — Task 1. The claim/lease/at-most-once machinery is unchanged: the job is already `inProgress` before `runFunction`, so a crash leaves it for the lease sweep = at-most-once.)

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/scheduler test scheduled-action` and the updated dispatch test
Expected: PASS (action runs; at-most-once on crash).

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS.

```bash
git add components/scheduler/src/driver.ts components/scheduler/test/
git commit -m "feat(scheduler): scheduled actions execute (remove the unsupported guard; at-most-once preserved)"
```

---

## Task 4: Client invocation — WebSocket `Action` + client `action()`/`useAction`

**Files:**
- Modify: `packages/sync/src/protocol.ts`, `packages/sync/src/handler.ts`, `packages/runtime-embedded/src/runtime.ts` (`SyncUdfExecutor.runAction`)
- Modify: `packages/client/src/client.ts`, `packages/client/src/react.ts` (or the hooks module)
- Test: `packages/sync/test/action.test.ts`, a client hook test

**Interfaces:**
- Consumes: Task 1's `runtime.runAction`.
- Produces: `ClientMessage | { type: "Action"; requestId: string; udfPath: string; args: JSONValue }`; `ServerMessage | { type: "ActionResponse"; requestId: string; success: true; value: JSONValue } | { type: "ActionResponse"; requestId: string; success: false; error: string }`; `SyncUdfExecutor.runAction(udfPath, args, identity): Promise<{ value: Value }>`; `client.action(ref, args): Promise<Value>`; `useAction(ref)`.

- [ ] **Step 1: Write the failing test**

`packages/sync/test/action.test.ts` — mirror the `Mutation` handler test with a fake `SyncUdfExecutor`:

```ts
it("handleAction runs the action and replies ActionResponse (no notifyWrites)", async () => {
  let notified = false;
  const ex = { /* runQuery/runMutation stubs */,
    async runAction(path: string) { return { value: `acted:${path}` as never }; } } as any;
  const h = new SyncProtocolHandler(ex, { verifyAdmin: () => false });
  const sent: any[] = []; const sock = { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} };
  h.connect("s1", sock as never);
  await h.handleMessage("s1", JSON.stringify({ type: "Action", requestId: "r1", udfPath: "app:act", args: {} }));
  const resp = sent.find((m) => m.type === "ActionResponse");
  expect(resp).toMatchObject({ requestId: "r1", success: true, value: "acted:app:act" });
});
```
Plus a client test: `client.action(ref, args)` sends `{type:"Action"}` and resolves on `ActionResponse` (fake transport, mirror the existing `client.mutation` test).

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/sync test action`
Expected: FAIL — `Action`/`ActionResponse`/`handleAction`/`runAction` unknown.

- [ ] **Step 3: Protocol (`protocol.ts`)**

Add to `ClientMessage`: `| { type: "Action"; requestId: string; udfPath: string; args: JSONValue }`. Add to `ServerMessage`: `| { type: "ActionResponse"; requestId: string; success: true; value: JSONValue } | { type: "ActionResponse"; requestId: string; success: false; error: string }`. Add `runAction(udfPath, args, identity?): Promise<{ value: Value }>` to `SyncUdfExecutor`.

- [ ] **Step 4: Handler (`handler.ts`)**

Add `case "Action": return this.handleAction(session, msg);` and:
```ts
  private async handleAction(session: Session, msg: Extract<ClientMessage, { type: "Action" }>): Promise<void> {
    try {
      const { value } = await this.executor.runAction(msg.udfPath, msg.args, session.identity);
      this.send(session, { type: "ActionResponse", requestId: msg.requestId, success: true, value: convexToJson(value) });
    } catch (e) {
      this.send(session, { type: "ActionResponse", requestId: msg.requestId, success: false, error: errMessage(e) });
    }
  }
```
NO `notifyWrites` (the action wrote nothing; inner mutations already fanned out). `errMessage`/`convexToJson` — reuse the same helpers `handleMutation` uses.

- [ ] **Step 5: Runtime `SyncUdfExecutor.runAction` (`runtime.ts`)**

In the `syncExecutor` object, add:
```ts
      async runAction(path, args, identity) {
        const r = await runAction-public-or-executor(path, args, identity);   // route to the public runAction (blocks `_`, checks type)
        return { value: r.value as Value };
      },
```
Use the same public gate as `runtime.runAction` (Task 1) — a client cannot invoke `_` paths.

- [ ] **Step 6: Client `action()` + `useAction`**

`client.ts`: add `pendingActions` map (mirror `pendingMutations`); `action(ref, args)` sends `{type:"Action", requestId, udfPath: getFunctionPath(ref), args}` and returns a promise resolved/rejected on `ActionResponse`; handle `ActionResponse` in the message switch; reject pendingActions on connection close. `react.ts`: `useAction(ref)` returns `(args) => client.action(ref, args)` (an async invoker, NOT reactive — mirror `useMutation`, not `useQuery`).

- [ ] **Step 7: Run — verify it passes**

Run: `bun run --filter @stackbase/sync test action` + the client test
Expected: PASS.

- [ ] **Step 8: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS.

```bash
git add packages/sync/src packages/runtime-embedded/src/runtime.ts packages/client/src packages/sync/test/action.test.ts packages/client/test/
git commit -m "feat(sync,client): one-shot Action WebSocket message + client action()/useAction"
```

---

## Task 5: E2E through the shipped server + HTTP + docs

**Files:**
- Test: `packages/cli/test/action-e2e.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Tasks 1–4 end-to-end.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/action-e2e.test.ts` — mirror `packages/cli/test/admin-browse-e2e.test.ts` (real `startDevServer`, real WebSocket). Prove the full path: a client `Action` over the real WS runs an action that `ctx.runMutation`-writes a row, returns a value, AND a separate live query subscription receives the write.

```ts
// 1. project: query app:list, mutation app:add, action app:act (calls ctx.runMutation("app:add"))
// 2. startDevServer; open a WS client; subscribe to app:list (expect []).
// 3. send { type:"Action", requestId, udfPath:"app:act", args:{body:"live"} };
//    assert ActionResponse.success === true.
// 4. assert the app:list subscription pushed ["live"] (the inner runMutation fanned out reactively).
// Also: POST /api/run { path:"app:act", args:{body:"http"} } returns the action's value (HTTP fallback).
// Also: an unknown action path over WS → ActionResponse.success === false.
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test action-e2e`
Expected: FAIL initially (write the test first; it passes once Tasks 1–4 are wired — if it fails for a real wiring reason, that's a genuine gap to fix, e.g. the sync handler not registering `Action`).

- [ ] **Step 3: Make it pass**

Should pass on the strength of Tasks 1–4. If the E2E reveals a shipped-server wiring gap (e.g. the CLI's `SyncUdfExecutor` wiring doesn't include `runAction`, or the handler isn't reached), fix it — this is exactly the gap-class the E2E exists to catch. Do NOT weaken the assertions.

- [ ] **Step 4: Update `CLAUDE.md`**

Under "What works", note actions are built: `action` functions execute (outside the txn, native `fetch`/`Date`/`random`, no `ctx.db`, orchestrate via `ctx.runQuery`/`runMutation`/`runAction`), callable from the scheduler (scheduled actions, at-most-once), other functions, the client (`useAction` over WS), and HTTP `/api/run`. Move actions out of the "Honestly deferred" list; note `httpAction` + the public HTTP router remain deferred. Update the build-order #5 line (actions half now shipped).

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS.

```bash
git add packages/cli/test/action-e2e.test.ts CLAUDE.md
git commit -m "test(actions): client-action E2E through the dev server (WS action -> runMutation -> reactive fan-out); docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 executor action path + `invoke` → Task 1. §4 ActionCtx (runQuery/runMutation/runAction) → Task 1; `ctx.scheduler` + component facades → Task 2. §5 scheduled actions → Task 3. §6 client WS `Action`/`ActionResponse` + handler + `action()`/`useAction` + HTTP → Task 4 (+ HTTP E2E in Task 5). §7 determinism/no-db/errors → Task 1 (no-db assertion) + Task 4 (error → ActionResponse). §8 testing → each task + Task 5 E2E. §9 files → matches. §10 out-of-scope (httpAction/timeouts/streaming) → not built. ✅

**Placeholder scan:** No TBD/TODO. Deliberate "recipe-not-transcription" spots (flagged): the exact `UdfResult` return shape for an action (told to grep + return the minimal valid object — it's a codebase-specific type), `resolveRef`/`getFunctionPath` (told to replicate the ~5-line existing resolver to avoid a client-package dep), the `ContextProvider` type location (told to grep), and the E2E harness (told to mirror `admin-browse-e2e.test.ts`). Each names a concrete existing pattern.

**Type consistency:** `ActionCtx` (`runQuery`/`runMutation`/`runAction`) identical Task 1 (define) → Task 2 (augment) → Task 3/5 (use). `invoke` signature `(path, args, opts?)` consistent executor (Task 1) ↔ runtime (Task 1). `buildAction(api)` consistent ContextProvider (Task 2) ↔ scheduler (Task 2). `Action`/`ActionResponse` + `SyncUdfExecutor.runAction` consistent protocol/handler (Task 4) ↔ runtime (Task 4) ↔ client (Task 4). `ctx.scheduler.runAfter(delayMs, ref, args)` matches the shipped mutation-facade signature (Task 2 note). The `_`-prefix rule is consistent: `invoke` allows `_` (server), public `runAction` + `SyncUdfExecutor.runAction` block `_` (client). ✅

**Scope note:** Task 2 (`ctx.scheduler` in actions) is the subtlest — it adds a generic `buildAction` seam rather than hardcoding scheduler into the executor, and honors the spec's committed `ctx.scheduler` surface. If a reviewer finds the `buildAction` machinery heavier than the value, that's a plan-vs-spec question for the human (the spec locked `ctx.scheduler` in the ActionCtx), not a silent drop.
