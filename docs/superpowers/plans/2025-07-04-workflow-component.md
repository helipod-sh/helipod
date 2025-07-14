# `@stackbase/workflow` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable multi-step workflow component — a workflow is an async handler whose progress survives crashes/restarts via a persisted journal + deterministic replay, driven by `@stackbase/scheduler`, with Convex `@convex-dev/workflow` parity plus `step.waitForEvent` and fan-out/fan-in.

**Architecture:** A `requires: ["scheduler"]` component. The user's handler runs INSIDE an internal `workflow:_advance` mutation under the executor's deterministic profile; a `steps` journal short-circuits already-completed steps (replay); the first incomplete step dispatches via `ctx.scheduler.enqueue(..., { onComplete: "workflow:_stepDone", context })` and the handler suspends. A step's completion fires `_stepDone` (the scheduler's onComplete), which journals the result and re-enqueues `_advance`. A `generationNumber` on the workflow row is a lock-free OCC guard.

**Tech Stack:** TypeScript, Bun, Turborepo, vitest. Built on `@stackbase/scheduler` (the facade `enqueue`/`cancel`, `fireOnComplete`, `OnCompleteResult`, `EnqueueOpts`), the action runtime (`kind:"action"` steps), the executor's deterministic profile, the reactive sync tier (live `status`), and the `driver`/commit-fan-out wake (`waitForEvent`).

## Global Constraints

- **Bun toolchain:** `bun run build`/`typecheck`/`test`; single pkg `bun run --filter @stackbase/workflow test`. Never pnpm/npm.
- **Deterministic-replay model** (not checkpoint, not DO). The handler runs inside `_advance` (a mutation) under the executor's deterministic profile; it may call ONLY `step.*`/`ctx.*` — no direct db, network, `Date`, `Math.random`.
- **`requires: ["scheduler"]`** — the workflow layer touches ONLY the scheduler's public facade (`ctx.scheduler.enqueue/cancel`, `fireOnComplete`). It NEVER re-implements dispatch, timers, or retries.
- **Convex `@convex-dev/workflow` API parity** (paste-and-run): `workflow.define`, `step.runMutation/runQuery/runAction(ref, args)`, `step.sleep(ms)`, `ctx.workflow.start/cancel`, `workflow.status`, `onComplete`.
- **Journal-mismatch = hard-throw** (`"Journal entry mismatch"`) — it is the entire determinism-violation surface.
- **`generationNumber` OCC guard:** every `_advance`/`_stepDone` captures it and self-discards if it changed (bumped on cancel/restart). A stale `_stepDone` MUST NOT resurrect a canceled workflow.
- **Delivery per step kind:** mutation/query steps exactly-once; **action steps at-most-once** (a crashed action step fails the step — never blind-retried; inherits the scheduler's contract).
- **Opt-in** via `stackbase.config.ts` (`defineWorkflow({ workflows })`); no auto-install. Reference pattern in `examples/auth-demo/stackbase.config.ts`.
- **Test through the shipped entrypoint:** the client-facing feature gets an E2E through the real `stackbase dev` server (Task 7) — mechanism unit tests have twice missed shipped-server wiring gaps in this project.
- **Scope:** v1 = replay core + `waitForEvent` + fan-out/fan-in. NOT in v1: saga/compensation, sub-workflows, replay-debugging, versioning, throttle/rate-limit. Do not build them.
- TDD, frequent commits, each task ends green (`build`/`typecheck`/`test`). `noUncheckedIndexedAccess: true`.

Backing detail: `docs/superpowers/specs/2025-07-04-workflow-component-design.md`; research `components/workflow/docs/{features,architecture-notes}.md` + `.reference/workflow-research/*`.

---

## File Structure (new `components/workflow/`, mirrors `components/scheduler/`)

- `src/schema.ts` — `workflows`/`steps`/`events`/`config` tables + indexes.
- `src/replay.ts` — the replay engine: the `step` object, the journal cursor, the cached-vs-new drive loop, fan-out collection.
- `src/facade.ts` — `ctx.workflow` (`start`/`cancel`/`sendEvent`) `context:` builder + `buildAction` (so it works in mutations AND actions).
- `src/modules.ts` — internal mutations `_advance`/`_stepDone`/`_start`/`_cancel`/`_sendEvent` + the `status` query. `_advance` is built via `makeAdvance(workflows)` (closure over the registry).
- `src/registry.ts` — `workflow.define(...)` + the `WorkflowRegistry` type (the `{ name → handler }` map passed to `defineWorkflow`).
- `src/index.ts` — `defineWorkflow({ workflows })` → `ComponentDefinition`.
- `src/package.json`, `tsconfig.json`, `tsup.config.ts` — mirror `components/scheduler/`.
- `test/{start-status,replay,occ-guard,action-sleep,fanout,wait-event}.test.ts` + `helpers.ts`.
- E2E: `packages/cli/test/workflow-e2e.test.ts`.

---

## Task 1: Component skeleton — schema + `defineWorkflow` + `start`/`status`

**Files:**
- Create: `components/workflow/{package.json,tsconfig.json,tsup.config.ts}` (copy `components/scheduler/`'s, rename to `@stackbase/workflow`), `components/workflow/src/{schema,registry,facade,modules,index}.ts`
- Test: `components/workflow/test/{helpers.ts,start-status.test.ts}`

**Interfaces:**
- Produces:
  ```ts
  // registry.ts
  export interface WorkflowHandlerCtx { /* the `step` object — filled in Task 2 */ }
  export type WorkflowHandler = (step: any, args: any) => Promise<unknown>;
  export function workflow_define(def: { handler: WorkflowHandler }): { handler: WorkflowHandler }; // exported as `define`
  export type WorkflowRegistry = Record<string, { handler: WorkflowHandler }>;
  // index.ts
  export function defineWorkflow(opts: { workflows: WorkflowRegistry }): ComponentDefinition;
  // facade.ts — ctx.workflow:
  //   start(ref: FnRefOrName, args: JSONValue): Promise<string /* runId */>
  //   cancel(runId: string): Promise<void>   // full impl Task 3
  // modules.ts:
  //   status = query((ctx, {runId}) => ({ state, result?, error? }) | null)
  //   _start = mutation((ctx, {workflowFnPath, args}) => runId)   // creates workflows row, enqueues _advance
  //   _advance = makeAdvance(workflows)  // STUB in Task 1: sets state unchanged; real loop in Task 2
  ```

- [ ] **Step 1: Write the failing test** (`test/start-status.test.ts`)

Mirror `components/scheduler/test/helpers.ts`'s `makeRuntimeWithScheduler` to write `makeRuntimeWithWorkflow(appModules, workflows)` returning `{ runtime, tick }` — it must `composeComponents` with BOTH `defineScheduler()` AND `defineWorkflow({ workflows })` (workflow requires scheduler) + the app modules, then `EmbeddedRuntime.create(...)` passing `tableNumbers`/`bootSteps`/`drivers` (copy the scheduler helper exactly, add the workflow component).

```ts
import { describe, it, expect } from "vitest";
import { mutation, query } from "@stackbase/executor";
import { workflow } from "@stackbase/workflow";   // the authoring surface: workflow.define
import { makeRuntimeWithWorkflow } from "./helpers";

describe("workflow start + status", () => {
  it("start() creates a running workflow and status() reflects it", async () => {
    const noop = workflow.define({ handler: async () => "done" });
    const { runtime } = await makeRuntimeWithWorkflow(
      { "app:kick": mutation(async (ctx: any, a: { x: number }) => ctx.workflow.start("app:noopFlow", { x: a.x })) },
      { "app:noopFlow": noop },
    );
    const runId = (await runtime.run("app:kick", { x: 1 })).value as string;
    expect(typeof runId).toBe("string");
    const st = (await runtime.run("workflow:status", { runId })).value as any;   // status is a query module
    expect(st.state).toBe("running");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test start-status`
Expected: FAIL — package/exports don't exist yet.

- [ ] **Step 3: Schema (`src/schema.ts`)**

Mirror `components/scheduler/src/schema.ts`. Define via `defineSchema`/`defineTable`/`v` (from `@stackbase/values`):
- `workflows`: `{ workflowFnPath: v.string(), args: v.any(), state: v.string(), generationNumber: v.number(), result: v.optional(v.any()), error: v.optional(v.string()), onComplete: v.optional(v.string()), context: v.optional(v.any()), recoveryAttempts: v.number(), startedTs: v.number(), completedTs: v.optional(v.number()) }`, index `by_state ["state"]`.
- `steps`: `{ workflowId: v.string(), stepNumber: v.number(), name: v.string(), kind: v.string(), args: v.any(), result: v.optional(v.any()), error: v.optional(v.string()), state: v.string(), scheduledJobId: v.optional(v.string()), startedTs: v.number(), completedTs: v.optional(v.number()) }`, index `by_workflow ["workflowId","stepNumber"]`.
- `events`: `{ workflowId: v.string(), name: v.string(), payload: v.optional(v.any()), state: v.string(), createdTs: v.number() }`, index `by_workflow_name ["workflowId","name"]`.
- `config`: minimal (a single-row tuning table is optional for T1 — you may defer it; if you add it, `{ maxJournalSteps: v.number(), maxRecoveryAttempts: v.number() }`).

- [ ] **Step 4: Registry + define (`src/registry.ts`)**

```ts
export type WorkflowHandler = (step: unknown, args: unknown) => Promise<unknown>;
export interface WorkflowDefinition { handler: WorkflowHandler }
export type WorkflowRegistry = Record<string, WorkflowDefinition>;
export function define(def: { handler: WorkflowHandler }): WorkflowDefinition { return { handler: def.handler }; }
```
In `src/index.ts` export a `workflow` namespace object so app code writes `workflow.define({...})`: `export const workflow = { define };`.

- [ ] **Step 5: Facade (`src/facade.ts`)**

Mirror `components/scheduler/src/facade.ts`'s structure. `workflowContext(cctx)` returns `ctx.workflow` with `start`/`cancel`. `start(ref, args)` resolves the ref to a path string (reuse the `resolveRef`/`getFunctionPath` convention — a workflow ref or string name), then delegates to an internal write: create the `workflows` row (`state:"running"`, `generationNumber:0`, `recoveryAttempts:0`, `startedTs:now`) via `cctx.db` (needs `contextWrite:true`), and enqueue `workflow:_advance` via `ctx.scheduler.enqueue("workflow:_advance", { workflowId }, { runAt: now })`. Return the `workflowId` as `runId`. (Access the scheduler facade through the component ctx — the workflow component `requires:["scheduler"]`, so `ctx.scheduler` is available; grep how a component reaches another component's facade — via `cctx.components` in `ComponentContext`. Confirm the shape; if `ctx.scheduler` isn't directly reachable from the workflow facade, enqueue via a `scheduler:_enqueue`-style internal call or thread it — check `ComponentContext.components`.)

> **Resolve the cross-component reach before coding:** read `packages/executor/src/executor.ts` `ComponentContext` (it has `components: Record<string,unknown>` — facades of components built before this one, i.e. the ones it `requires`). So `cctx.components.scheduler` is the scheduler facade. Use `(cctx.components.scheduler as SchedulerFacade).enqueue(...)`.

- [ ] **Step 6: Modules (`src/modules.ts`) + `makeAdvance` stub**

```ts
export const status = query(async (ctx: any, a: { runId: string }) => {
  const wf = await ctx.db.get(a.runId);
  if (!wf) return null;
  return { state: wf.state, result: wf.result, error: wf.error };
});
// _advance STUB for Task 1 — real replay loop is Task 2. For now it just no-ops (leaves state "running").
export function makeAdvance(_workflows: WorkflowRegistry) {
  return mutation(async (_ctx: any, _a: { workflowId: string }) => null);
}
```
(`_start` isn't needed as a separate module if `ctx.workflow.start` writes directly in the calling mutation's txn — prefer that: `start` runs in the caller's transaction via `contextWrite`, exactly like `ctx.scheduler.runAfter`. Keep the row-creation in the facade.)

- [ ] **Step 7: `defineWorkflow` (`src/index.ts`)**

```ts
export function defineWorkflow(opts: { workflows: WorkflowRegistry }): ComponentDefinition {
  return defineComponent({
    name: "workflow",
    schema: workflowSchema,
    requires: ["scheduler"],
    modules: { _advance: makeAdvance(opts.workflows), status /* + _stepDone/_cancel/_sendEvent added later */ },
    context: (cctx) => workflowContext(cctx),
    contextType: { import: "@stackbase/workflow", type: "WorkflowContext" },
    contextWrite: true,
    buildAction: (api) => workflowActionContext(api), // full impl Task 7; a minimal start-only version is fine now
  });
}
```

- [ ] **Step 8: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test start-status`
Expected: PASS (start creates a running workflow; status reads it).

- [ ] **Step 9: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (new package; add it to the workspace if the root config needs it — mirror how `@stackbase/scheduler` is wired in `package.json`/`turbo`/tsconfig references).

```bash
git add components/workflow packages/*/tsconfig* package.json 2>/dev/null
git commit -m "feat(workflow): component skeleton — schema, defineWorkflow, ctx.workflow.start + status"
```

---

## Task 2: The replay loop — `_advance` + `step.runMutation/runQuery` + `_stepDone` (sequential)

**This is the heart of the component. Read `.reference/workflow-research/convex-workflow.md` §1-2 (the `StepExecutor.run` racing loop, `step.ts:84-112`) before implementing — the drive mechanism is subtle.**

**Files:**
- Create: `components/workflow/src/replay.ts`
- Modify: `components/workflow/src/modules.ts` (real `makeAdvance`, add `_stepDone`), `components/workflow/src/index.ts` (register `_stepDone`)
- Test: `components/workflow/test/replay.test.ts`

**Interfaces:**
- Consumes: Task 1's schema, facade, registry; the scheduler facade (`cctx.components.scheduler`), `fireOnComplete`/`OnCompleteResult` from `@stackbase/scheduler`.
- Produces:
  ```ts
  // replay.ts — the step object + the drive loop
  export interface StepApi {
    runMutation<T=unknown>(ref: FnRefOrName, args?: Record<string, unknown>): Promise<T>;
    runQuery<T=unknown>(ref: FnRefOrName, args?: Record<string, unknown>): Promise<T>;
    // runAction/sleep/waitForEvent added in Tasks 4/6
  }
  // runReplay(handler, handlerArgs, journal, dispatch): Promise<ReplayOutcome>
  //   ReplayOutcome = { kind:"completed"; result } | { kind:"failed"; error } | { kind:"suspended"; newSteps: NewStep[] }
  //   NewStep = { stepNumber, name, kind, args }
  // modules.ts:
  //   _stepDone = mutation((ctx, { jobId, context:{workflowId,stepNumber,generationNumber}, result:OnCompleteResult }) => null)
  ```

- [ ] **Step 1: Write the failing test** (`test/replay.test.ts`)

```ts
it("a 3-step sequential workflow runs each step once and completes", async () => {
  const log: string[] = [];
  const flow = workflow.define({ handler: async (step: any) => {
    const a = await step.runMutation("app:s", { n: 1 });
    const b = await step.runMutation("app:s", { n: 2 });
    const c = await step.runMutation("app:s", { n: 3 });
    return [a, b, c];
  }});
  const { runtime, tick } = await makeRuntimeWithWorkflow(
    { "app:kick": mutation(async (ctx:any) => ctx.workflow.start("app:flow", {})),
      "app:s": mutation(async (_c:any, x:{n:number}) => { log.push(`run${x.n}`); return x.n * 10; }) },
    { "app:flow": flow },
  );
  const runId = (await runtime.run("app:kick", {})).value as string;
  await tick(); await tick(); await tick(); await tick();   // drive the scheduler until the workflow settles
  const st = (await runtime.run("workflow:status", { runId })).value as any;
  expect(st.state).toBe("completed");
  expect(st.result).toEqual([10, 20, 30]);
  expect(log).toEqual(["run1", "run2", "run3"]);            // each step ran exactly once (replay didn't re-run)
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test replay`
Expected: FAIL — `_advance` is a stub; the workflow never progresses.

- [ ] **Step 3: The replay drive loop (`src/replay.ts`)**

Implement the racing drive (paraphrasing Convex `StepExecutor.run`, do NOT copy). The algorithm:

```ts
export type NewStep = { stepNumber: number; name: string; kind: "mutation"|"query"; args: JSONValue };
export type ReplayOutcome =
  | { kind: "completed"; result: unknown }
  | { kind: "failed"; error: string }
  | { kind: "suspended"; newSteps: NewStep[] };

// journal: ordered array of the workflow's `steps` rows (by stepNumber).
export async function runReplay(
  handler: WorkflowHandler,
  handlerArgs: unknown,
  journal: ReadonlyArray<JournalRow>,
): Promise<ReplayOutcome> {
  let cursor = 0;                         // next journal index to consume
  const newSteps: NewStep[] = [];
  let blocked = false;                    // set true once the handler awaits an un-journaled step

  const requestStep = (kind: "mutation"|"query", ref: unknown, args: JSONValue): Promise<unknown> => {
    const name = resolveRef(ref);
    const idx = cursor++;
    const cached = journal[idx];
    if (cached) {
      // Replay: validate identity, then resolve/reject from the journal — NO re-execution.
      if (cached.name !== name || cached.kind !== kind || !deepEqual(cached.args, args))
        throw new Error(`Journal entry mismatch at step ${idx}: expected ${cached.name}/${cached.kind}, got ${name}/${kind}`);
      if (cached.state === "success") return Promise.resolve(cached.result);
      if (cached.state === "failed") return Promise.reject(new Error(cached.error ?? "step failed"));
      // pending (already dispatched, not yet done): this step is in flight — suspend on it (never resolves this poll).
      blocked = true;
      return new Promise(() => {});       // permanently pending — handler abandoned after this poll
    }
    // New step: record it to dispatch, and suspend the handler here.
    blocked = true;
    newSteps.push({ stepNumber: idx, name, kind, args });
    return new Promise(() => {});         // permanently pending
  };

  const step = { runMutation: (r,a={}) => requestStep("mutation", r, a), runQuery: (r,a={}) => requestStep("query", r, a) };

  // Race the handler against "blocked": drain microtasks; if the handler settles, it's done; if it's
  // blocked on new/pending steps, dispatch them. NOTE fan-out (Task 5): a Promise.all emits several
  // requestStep calls (pushing several newSteps) before the first await blocks — so collect ALL newSteps
  // emitted before settling, not just the first.
  const settle = handler(step, handlerArgs).then(
    (result) => ({ kind: "completed", result } as ReplayOutcome),
    (e) => ({ kind: "failed", error: String(e instanceof Error ? e.message : e) } as ReplayOutcome),
  );
  // Give the handler synchronous+microtask runway to consume all cached steps and emit its new-step requests.
  const drained = await Promise.race([settle, drainMicrotasks().then(() => ({ kind: "suspended", newSteps } as ReplayOutcome))]);
  return drained.kind === "suspended" ? { kind: "suspended", newSteps } : drained;
}
```

> `drainMicrotasks()` = `await Promise.resolve()` a few times (e.g. loop `await new Promise(r => setTimeout(r, 0))` once, or several `await Promise.resolve()`), enough for the handler to run through all synchronously-cached steps and register its next new-step request(s) before you conclude "suspended". Because cached steps resolve SYNCHRONOUSLY via `Promise.resolve(value)`, the handler advances through them in microtasks; a genuinely new step returns a never-resolving promise, blocking the handler. Tune the drain to reliably let all cached steps flush. Provide `deepEqual` (a small structural compare — or reuse one from `@stackbase/values` if present; grep) and `resolveRef` (string-or-ref → path, replicate the executor's tiny helper). If `settle` wins the race, the handler completed/failed with all steps cached. If the drain wins, the handler is suspended on `newSteps`.

- [ ] **Step 4: Real `_advance` (`makeAdvance`) + `_stepDone` (`src/modules.ts`)**

```ts
export function makeAdvance(workflows: WorkflowRegistry) {
  return mutation(async (ctx: any, a: { workflowId: string }) => {
    const wf = await ctx.db.get(a.workflowId);
    if (!wf || wf.state !== "running") return null;                 // terminal/canceled — no-op
    const gen = wf.generationNumber as number;
    const def = workflows[wf.workflowFnPath as string];
    if (!def) throw new Error(`unknown workflow ${wf.workflowFnPath}`);
    const journal = await ctx.db.query("steps", "by_workflow").eq("workflowId", a.workflowId).collect(); // ordered by stepNumber
    const outcome = await runReplay(def.handler, wf.args, journal);
    const sched = ctx.scheduler;                                    // the scheduler facade (requires:["scheduler"])
    if (outcome.kind === "completed") {
      await ctx.db.replace(a.workflowId, { ...wf, state: "completed", result: outcome.result, completedTs: ctx.now() });
      await fireWorkflowOnComplete(ctx, wf, { kind: "success", value: outcome.result });
    } else if (outcome.kind === "failed") {
      await ctx.db.replace(a.workflowId, { ...wf, state: "failed", error: outcome.error, completedTs: ctx.now() });
      await fireWorkflowOnComplete(ctx, wf, { kind: "failed", error: outcome.error });
    } else {
      // suspended — write journal rows + dispatch each new step via the scheduler with onComplete→_stepDone.
      for (const ns of outcome.newSteps) {
        await ctx.db.insert("steps", { workflowId: a.workflowId, stepNumber: ns.stepNumber, name: ns.name,
          kind: ns.kind, args: ns.args, state: "pending", startedTs: ctx.now() });
        await sched.enqueue(ns.name, ns.args, { onComplete: "workflow:_stepDone",
          context: { workflowId: a.workflowId, stepNumber: ns.stepNumber, generationNumber: gen } });
      }
    }
    return null;
  });
}

export const _stepDone = mutation(async (ctx: any, a: { jobId: string;
    context: { workflowId: string; stepNumber: number; generationNumber: number }; result: OnCompleteResult }) => {
  const wf = await ctx.db.get(a.context.workflowId);
  if (!wf || wf.generationNumber !== a.context.generationNumber) return null;   // OCC guard (Task 3 tests this)
  const row = (await ctx.db.query("steps", "by_workflow").eq("workflowId", a.context.workflowId)
    .collect()).find((s:any) => s.stepNumber === a.context.stepNumber);
  if (!row) return null;
  if (a.result.kind === "success")
    await ctx.db.replace(row._id, { ...row, state: "success", result: a.result.value, completedTs: ctx.now() });
  else
    await ctx.db.replace(row._id, { ...row, state: "failed", error: a.result.kind === "failed" ? a.result.error : "canceled", completedTs: ctx.now() });
  await ctx.scheduler.enqueue("workflow:_advance", { workflowId: a.context.workflowId }, {});  // re-poll
  return null;
});
```
> `fireWorkflowOnComplete` = a small helper that, if `wf.onComplete` is set, enqueues it with the workflow's `context` + result (mirror the scheduler's `fireOnComplete`; or reuse `fireOnComplete` directly against the workflow row if the shapes line up — the workflow onComplete is optional in v1, so a minimal version is fine). `ctx.scheduler` availability inside a module: `_advance`/`_stepDone` run with the workflow component's context provider active, so `ctx.scheduler` is present (the scheduler facade) — same as `_cronTick` reaching `ctx.scheduler` in the scheduler component. Confirm and use it; if not directly on `ctx`, reach via the component-composition path you established in Task 1.

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test replay`
Expected: PASS — 3 steps run once each, workflow completes with `[10,20,30]`. If the drive loop's microtask draining is flaky, harden `drainMicrotasks` until the cached-step flush is deterministic.

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`

```bash
git add components/workflow
git commit -m "feat(workflow): deterministic replay loop — _advance runs the handler, journals + dispatches steps, _stepDone advances"
```

---

## Task 3: `generationNumber` OCC guard + `cancel` + journal-mismatch

**Files:**
- Modify: `components/workflow/src/{facade,modules}.ts` (real `cancel`; the guard is already in `_stepDone` from Task 2 — add it to `_advance` too and test both)
- Test: `components/workflow/test/occ-guard.test.ts`

**Interfaces:**
- Consumes: Task 2's `_advance`/`_stepDone`/journal.
- Produces: `ctx.workflow.cancel(runId)` — bumps `generationNumber`, sets `state:"canceled"`, cascades cancel to in-flight step jobs.

- [ ] **Step 1: Write the failing test** (`test/occ-guard.test.ts`)

Three tests:
```ts
it("a _stepDone carrying a stale generationNumber (after cancel) does not resurrect the workflow", async () => {
  // start a workflow that dispatches step 0; cancel it (bumps gen 0→1, state canceled);
  // then hand-fire workflow:_stepDone with context.generationNumber=0 (the stale one) via runtime.run;
  // assert the workflow stays "canceled" and no new step was dispatched.
});
it("cancel sets state canceled and cascades cancel to the in-flight step job", async () => {
  // start; assert an in-flight steps row pending + a scheduler job exists; cancel; assert workflow canceled
  // and the scheduler job for the in-flight step is canceled (state canceled in scheduler/jobs).
});
it("a journal-entry mismatch throws (determinism violation)", async () => {
  // Drive a workflow to journal step 0 as app:s. Then (simulating a non-deterministic handler) replay with a
  // handler whose first step is app:OTHER — assert runReplay throws /Journal entry mismatch/.
  // Easiest: a direct unit test of runReplay() with a crafted journal + a mismatching handler.
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test occ-guard`
Expected: FAIL — `cancel` is a stub; the guard on `_advance` may be missing.

- [ ] **Step 3: Implement `cancel` + guard `_advance`**

`ctx.workflow.cancel(runId)`: read the workflow row; set `state:"canceled"`, `generationNumber: gen+1`, `completedTs:now` via `ctx.db.replace`. Then cascade-cancel in-flight step jobs: for each `steps` row with `state:"pending"` and a `scheduledJobId`, call `ctx.scheduler.cancel(scheduledJobId)` (the scheduler's cascading cancel). Add the same `if (wf.generationNumber !== capturedGen) return` guard to `_advance` (it already reads `wf` and captures `gen`; ensure a re-poll after a generation bump no-ops — `state !== "running"` already covers cancel, but keep the explicit gen capture for the double-advance case). The journal-mismatch throw already lives in `runReplay` (Task 2) — the third test exercises it directly.

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test occ-guard`
Expected: PASS.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add components/workflow
git commit -m "feat(workflow): generationNumber OCC guard + cascading cancel + journal-mismatch determinism throw"
```

---

## Task 4: Action steps + `step.sleep` + per-step retries

**Files:**
- Modify: `components/workflow/src/replay.ts` (add `runAction`, `sleep`, `sleepUntil`, per-step retry opts to the `step` object + NewStep kinds)
- Test: `components/workflow/test/action-sleep.test.ts`

**Interfaces:**
- Consumes: the action runtime (`kind:"action"` scheduler jobs), the scheduler's `runAt`/`retry` opts.
- Produces: `step.runAction(ref, args, opts?)`, `step.sleep(ms)`, `step.sleepUntil(ts)`; `NewStep.kind` extended to `"action"|"sleep"`; `NewStep.opts?: { runAt?; maxAttempts? }`.

- [ ] **Step 1: Write the failing test** (`test/action-sleep.test.ts`)

```ts
it("an action step runs and its result is journaled", async () => {
  const ran: string[] = [];
  const flow = workflow.define({ handler: async (step:any) => {
    const r = await step.runAction("app:act", { to: "x" });
    return r;
  }});
  const { runtime, tick } = await makeRuntimeWithWorkflow(
    { "app:kick": mutation(async (ctx:any) => ctx.workflow.start("app:flow", {})),
      "app:act": action(async (_c:any, a:{to:string}) => { ran.push(a.to); return `sent:${a.to}`; }) },
    { "app:flow": flow });
  const runId = (await runtime.run("app:kick", {})).value as string;
  await tick(); await tick(); await tick();
  const st = (await runtime.run("workflow:status", { runId })).value as any;
  expect(ran).toEqual(["x"]);
  expect(st.state).toBe("completed");
  expect(st.result).toBe("sent:x");
});
it("step.sleep parks then resumes (a delayed step)", async () => { /* start; assert a kind:"sleep" step dispatched runAt=now+ms; advance past it; workflow completes */ });
it("a crashed action step is at-most-once — the step fails, workflow sees failure (not a blind re-run)", async () => {
  // action step whose job is forced inProgress+expired-lease → _reclaim marks it failed → _stepDone(failed) →
  // workflow state "failed"; the action's side-effect counter did not increment twice.
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test action-sleep`
Expected: FAIL — `step.runAction`/`sleep` don't exist.

- [ ] **Step 3: Extend the `step` object (`src/replay.ts`)**

Add `runAction(ref, args, opts?)` — identical to `requestStep` but `kind:"action"`, carrying `opts.maxAttempts` into `NewStep.opts`. Add `sleep(ms)` / `sleepUntil(ts)` — a `NewStep` with `kind:"sleep"`, a synthetic `name` (e.g. `"workflow:_sleep"` — a trivial internal no-op mutation you register that just returns null), and `opts.runAt = now + ms` (or `ts`). In `makeAdvance`'s dispatch loop, pass `ns.opts` into `sched.enqueue(name, args, { runAt: ns.opts?.runAt, retry: ns.opts?.maxAttempts ? { maxFailures: ns.opts.maxAttempts } : undefined, onComplete: "workflow:_stepDone", context: {...} })`. For a `sleep` step, the dispatched fn is `workflow:_sleep` (register it: `export const _sleep = mutation(async () => null)`), so the step "completes" when its delayed job runs → `_stepDone` journals it → replay proceeds.

> Determinism note: `step.sleep(ms)` computes `runAt` inside `_advance` (a mutation) using `ctx.now()` — the fixed per-invocation clock. That's deterministic per poll; the sleep's actual delay rides the scheduler's `runAt`. Do NOT use `Date.now()` in the handler.

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test action-sleep`
Expected: PASS (action step runs once, at-most-once on crash, sleep parks+resumes).

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add components/workflow
git commit -m "feat(workflow): action steps (at-most-once), step.sleep/sleepUntil, per-step retries"
```

---

## Task 5: Fan-out / fan-in

**Files:**
- Modify: `components/workflow/src/replay.ts` (ensure multiple new steps emitted in one poll are all collected + dispatched; the handler resumes only after ALL journal)
- Test: `components/workflow/test/fanout.test.ts`

**Interfaces:**
- Consumes: Task 2's `runReplay` (`newSteps` array already supports multiple).

- [ ] **Step 1: Write the failing test** (`test/fanout.test.ts`)

```ts
it("Promise.all fans out N steps in one poll and joins after all complete", async () => {
  const order: string[] = [];
  const flow = workflow.define({ handler: async (step:any) => {
    const [a, b] = await Promise.all([step.runMutation("app:a", {}), step.runMutation("app:b", {})]);
    order.push("joined");
    return [a, b];
  }});
  const { runtime, tick } = await makeRuntimeWithWorkflow(
    { "app:kick": mutation(async (ctx:any) => ctx.workflow.start("app:flow", {})),
      "app:a": mutation(async () => { order.push("a"); return "A"; }),
      "app:b": mutation(async () => { order.push("b"); return "B"; }) },
    { "app:flow": flow });
  const runId = (await runtime.run("app:kick", {})).value as string;
  await tick(); await tick(); await tick(); await tick();
  const st = (await runtime.run("workflow:status", { runId })).value as any;
  expect(st.state).toBe("completed");
  expect(st.result).toEqual(["A", "B"]);
  expect(order.filter(x=>x==="joined").length).toBe(1);      // joined exactly once, after both
  expect(order.indexOf("joined")).toBeGreaterThan(order.indexOf("a"));
  expect(order.indexOf("joined")).toBeGreaterThan(order.indexOf("b"));
});
```

- [ ] **Step 2: Run — verify it fails or is flaky**

Run: `bun run --filter @stackbase/workflow test fanout`
Expected: FAIL/flaky — the Task 2 drive loop may only collect the FIRST new step per poll (a `Promise.all` emits two `requestStep` calls before awaiting; both must be collected before concluding "suspended").

- [ ] **Step 3: Fix the collection in `runReplay`**

Ensure the drain gives the handler enough runway to emit ALL synchronously-issued new-step requests before you conclude "suspended". With `Promise.all([step.a(), step.b()])`, both `requestStep` calls execute synchronously (before any await), so both push to `newSteps` in the same tick — the existing `newSteps` array already collects them; the fix is ensuring `drainMicrotasks` doesn't conclude "suspended" after only the first. Verify the drive collects both; if the drain races too early, widen it (the handler issues both requests synchronously, so a single microtask turn suffices — the bug, if any, is concluding before the synchronous emit finishes). Cap concurrent dispatches with a `config.maxParallelism` (default e.g. 16) if `newSteps.length` exceeds it — dispatch the first N, leave the rest for the next poll (they'll re-emit on replay). Document the cap with `log()`/a comment; do not silently drop.

- [ ] **Step 4: Run — verify it passes** (run several times — it must be deterministic, not flaky)

Run: `bun run --filter @stackbase/workflow test fanout`
Expected: PASS reliably.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add components/workflow
git commit -m "feat(workflow): fan-out/fan-in — Promise.all over steps dispatches all, joins after all complete"
```

---

## Task 6: `waitForEvent` + `sendEvent`

**Files:**
- Create: `components/workflow/src/events.ts`
- Modify: `components/workflow/src/{replay,facade,modules}.ts`, `src/index.ts` (register `_sendEvent`)
- Test: `components/workflow/test/wait-event.test.ts`

**Interfaces:**
- Produces: `step.waitForEvent(name, { timeoutMs? }?) → payload`; `ctx.workflow.sendEvent(runId, name, payload)` (+ internal `_sendEvent`).

- [ ] **Step 1: Write the failing test** (`test/wait-event.test.ts`)

```ts
it("waitForEvent parks the workflow until sendEvent resolves it", async () => {
  const flow = workflow.define({ handler: async (step:any) => {
    const approval = await step.waitForEvent("approved");
    return approval;
  }});
  const { runtime, tick } = await makeRuntimeWithWorkflow(
    { "app:kick": mutation(async (ctx:any) => ctx.workflow.start("app:flow", {})),
      "app:send": mutation(async (ctx:any, a:{runId:string}) => ctx.workflow.sendEvent(a.runId, "approved", { by: "mgr" })) },
    { "app:flow": flow });
  const runId = (await runtime.run("app:kick", {})).value as string;
  await tick(); await tick();
  expect((await runtime.run("workflow:status", { runId })).value.state).toBe("running");  // parked
  await runtime.run("app:send", { runId });               // resolve the event
  await tick(); await tick();
  const st = (await runtime.run("workflow:status", { runId })).value as any;
  expect(st.state).toBe("completed");
  expect(st.result).toEqual({ by: "mgr" });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test wait-event`
Expected: FAIL — `waitForEvent`/`sendEvent` don't exist.

- [ ] **Step 3: Implement waitpoints (`src/events.ts`, `replay.ts`, `modules.ts`, `facade.ts`)**

- `step.waitForEvent(name, opts?)`: a `NewStep`-like entry with `kind:"waitForEvent"`, but its "dispatch" is NOT a scheduler job — instead `_advance`, when it sees a new `waitForEvent` step, writes an `events` row `{ workflowId, name, state:"waiting" }` and a `steps` row (`state:"pending"`, kind `waitForEvent`) and does NOT enqueue a scheduler job. The handler suspends on it (never resolves this poll). On replay, a `waitForEvent` step whose `events` row is `state:"received"` resolves with the payload (journal the step `success` with the payload as result when the event arrives — see `_sendEvent`). (For the optional `timeoutMs`: also dispatch a companion `sleep` step; whichever completes first wins — v1 may implement `waitForEvent` without timeout first and add the timeout companion if scope allows; the test above omits timeout.)
- `ctx.workflow.sendEvent(runId, name, payload)` → an internal `_sendEvent` mutation: find the `events` row (`by_workflow_name`, `state:"waiting"`); set `state:"received"`, `payload`; find the matching `waitForEvent` `steps` row and set it `success` with `result: payload`; then `ctx.scheduler.enqueue("workflow:_advance", { workflowId }, {})` to re-poll. The commit fan-out wakes the driver → the re-enqueued `_advance` runs → replay resolves the `waitForEvent` step from the journal.
- In `runReplay`, `step.waitForEvent` uses the same cursor/cached logic: a cached `waitForEvent` step that is `success` resolves with `result`; `pending` → suspend (blocked, no new dispatch — it's already waiting). A brand-new `waitForEvent` → emit a `NewStep` with `kind:"waitForEvent"` (no scheduler dispatch; `_advance` handles it specially by writing the `events` row instead of enqueuing).

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test wait-event`
Expected: PASS (parks, then completes on sendEvent).

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add components/workflow
git commit -m "feat(workflow): step.waitForEvent + ctx.workflow.sendEvent — durable signals on the commit-fan-out wake"
```

---

## Task 7: Action-mode facade + codegen + E2E + docs

**Files:**
- Modify: `components/workflow/src/facade.ts` (`workflowActionContext` — `start`/`sendEvent`/`cancel` from an action, via `buildAction`), `src/index.ts` (`serverExports`, `buildAction`), `packages/codegen/*` (if `workflow.define`/typed refs need emitting — reuse the scheduler's `serverExports` seam), `examples/auth-demo/stackbase.config.ts`, `CLAUDE.md`
- Test: `packages/cli/test/workflow-e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6.

- [ ] **Step 1: Write the failing E2E** (`packages/cli/test/workflow-e2e.test.ts`)

Mirror `packages/cli/test/action-e2e.test.ts` (real `startDevServer`/`loadProject` + real WS + real HTTP). Prove the full loop through the shipped server:
```ts
// project: a workflow app:orderFlow = runMutation(app:step1) -> runAction(app:step2) -> waitForEvent("go") -> return;
//   plus mutations app:kick (ctx.workflow.start) and app:go (ctx.workflow.sendEvent), and a live status query.
// 1. startDevServer; WS client; call app:kick over WS → get runId.
// 2. poll workflow:status (or subscribe) — assert it reaches "running" and step1/step2 ran.
// 3. call app:go over WS (sendEvent) — assert workflow:status transitions to "completed" with the expected result.
// 4. assert an action step actually executed (a row it wrote is visible via the admin browse / a query).
// bounded ~10s timeout.
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test workflow-e2e`
Expected: FAIL (initially — passes once the action-mode facade + wiring are in). If it exposes a real shipped-server wiring gap (e.g. the workflow component's `bootSteps`/`drivers` — it has none, but `contextWrite`/`buildAction` must be composed), FIX it (systematic debugging, root cause) — do NOT weaken assertions.

- [ ] **Step 3: Action-mode facade (`workflowActionContext`)**

Mirror `components/scheduler/src/facade.ts`'s `schedulerActionContext`: `ctx.workflow.start/sendEvent/cancel` inside an action delegate to internal mutations via `api.runMutation` (a `workflow:_start`/`_sendEvent`/`_cancel` — add `_start`/`_cancel` internal mutations if the facade's in-txn versions can't run from an action; the action has no db, so it must delegate to a mutation, exactly as the scheduler's action-mode `runAfter` delegates to `scheduler:_enqueue`). Wire `buildAction: (api) => workflowActionContext(api)` in `defineWorkflow`. These internal modules are `_`-prefixed → blocked from clients by `isInternalPath` (already hardened); reachable via `invoke` from an action.

- [ ] **Step 4: Codegen + config + docs**

- Codegen: if `workflow.define` + typed workflow refs need emitting, add `serverExports: ["workflow"]` (or the right symbol) to `defineWorkflow` — reuse the scheduler's `serverExports` seam (`packages/codegen`); confirm `internal`/`api` refs to workflows resolve. If workflows are referenced by string path in v1 (like the scheduler's cron work fns), minimal codegen is fine — match the scheduler's level.
- `examples/auth-demo/stackbase.config.ts`: add `defineWorkflow({ workflows: { /* a sample */ } })` alongside `defineScheduler()` (the reference opt-in pattern).
- `CLAUDE.md`: add `@stackbase/workflow` to "What works" — durable multi-step workflows (deterministic replay, journal, generationNumber OCC guard), Convex `@convex-dev/workflow` parity (`step.runMutation/runQuery/runAction`, `sleep`, `start`/`status`(live)/`cancel`/`onComplete`), `waitForEvent`/`sendEvent`, fan-out/fan-in; built on the scheduler; note saga/sub-workflows deferred to v1.1.

- [ ] **Step 5: Run — verify the E2E passes**

Run: `bun run --filter @stackbase/cli test workflow-e2e`
Expected: PASS (the whole loop through the real server).

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add components/workflow packages/codegen examples/auth-demo/stackbase.config.ts CLAUDE.md packages/cli/test/workflow-e2e.test.ts
git commit -m "feat(workflow): action-mode facade + codegen + Convex-parity E2E through the dev server; docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 execution model (handler in `_advance`) → T2. §4 journal tables → T1. §5 replay loop + `_stepDone` + generationNumber → T2 (loop) + T3 (guard). §6 step API: runMutation/runQuery → T2, runAction/sleep → T4, waitForEvent/sendEvent → T6, fan-out → T5, start/status → T1, cancel → T3, onComplete → T2 (`fireWorkflowOnComplete`), live status → T1. §7 determinism (journal-mismatch throw) → T2/T3, action at-most-once → T4, recovery/journal caps → noted (recovery-attempts field in schema T1; the cap enforcement is light in v1 — the field exists; a full recovery-cap loop is a fast-follow if not exercised, flagged). §8 testing → each task + E2E T7. §9 files → matches. §10 out-of-scope (saga/sub-workflows/versioning) → not built. ✅

**Placeholder scan:** No TBD/TODO. Deliberate "recipe-not-transcription" spots (flagged for the implementer): the `runReplay` drive loop's microtask-drain tuning (T2 Step 3 — the subtle part; the implementer must read `.reference/workflow-research/convex-workflow.md` §1-2 and make the cached-step flush deterministic), `deepEqual`/`resolveRef` (told to reuse/replicate existing helpers — grep first), the cross-component reach to `ctx.scheduler` (T1 Step 5 — told to confirm `ComponentContext.components.scheduler`), codegen level (T7 — told to match the scheduler's `serverExports`).

**Type consistency:** `runReplay → ReplayOutcome {completed|failed|suspended}` consistent T2→T5. `NewStep {stepNumber,name,kind,args,opts?}` consistent T2 (mutation/query) → T4 (action/sleep) → T6 (waitForEvent). `_stepDone` arg `{jobId, context:{workflowId,stepNumber,generationNumber}, result:OnCompleteResult}` matches the scheduler's `fireOnComplete` enqueue shape (verified: `fireOnComplete` enqueues `{jobId, context, result}`). `ctx.workflow` methods `start/cancel/sendEvent` consistent facade (T1/T3/T6) ↔ action facade (T7). `generationNumber` guard identical in `_advance` (T3) and `_stepDone` (T2). ✅

**Scope note:** the recovery-attempts CAP (dead-letter a crash-looping workflow) has a schema field (T1) but no task fully exercises the cap loop — v1 stores the field; enforcing the cap is a light fast-follow if the E2E doesn't cover a process-crash-loop. Flag to the final review, not a silent drop. The `config` max-parallelism (T5) and journal-size cap (T7-ish) are similarly light — fields/knobs exist; hard enforcement is fast-follow. These are honest v1 edges, not gaps in the core replay/advance/guard mechanism.
