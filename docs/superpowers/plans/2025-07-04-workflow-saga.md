# `@stackbase/workflow` Saga / Compensation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add declarative per-step compensation (saga) to `@stackbase/workflow`: `step.runAction(ref, args, { compensate: undoRef })`; on failure or a compensating cancel, the recorded undo-handlers run in reverse `stepNumber` order via a durable `_compensate` loop, then the workflow reaches a terminal state.

**Architecture:** Saga is the reverse traversal of the existing journal. Forward `_advance` records each step's declared `compensateFnPath` on its `steps` row. Where `_advance` today terminal-fails a workflow, it instead enters a `compensating` state (if any compensation was recorded) and enqueues `workflow:_compensate` — a NEW internal loop that finds the highest-`stepNumber` un-compensated `success` step with a `compensateFnPath`, dispatches its undo via the scheduler (`onComplete:"workflow:_compensateDone"`), and repeats in reverse until none remain, then goes terminal. Compensation is itself journaled + scheduler-dispatched, so it is crash-durable and retried exactly like forward steps. No new engine primitive.

**Tech Stack:** TypeScript, Bun, Turborepo, vitest. Extends `@stackbase/workflow` (the `steps` journal, `_advance`/`_stepDone`, the `generationNumber` OCC guard, `ctx.workflow.cancel`) + `@stackbase/scheduler` (facade `enqueue`/`cancel`, `fireOnComplete`, `OnCompleteResult`).

## Global Constraints

- **Bun toolchain:** `bun run build`/`typecheck`/`test`; single pkg `bun run --filter @stackbase/workflow test`. Never pnpm/npm.
- **Saga reuses the existing durable-step machinery** — a compensation is dispatched via `ctx.scheduler.enqueue(compensateFnPath, {args, result}, { onComplete:"workflow:_compensateDone", context })` exactly like a forward step. NO new scheduler mechanism, NO new driver.
- **Compensation is the reverse traversal, NOT handler-replay.** The handler already failed; re-running it would re-throw. `_compensate` is a dedicated journal walk (descending `stepNumber`), not a replay.
- **`compensate` is a per-step option** (`{ compensate: FnRef }`) on `runMutation`/`runAction` (and accepted-but-unusual on the other kinds). The compensation receives `{ args, result }` of its original step.
- **A compensation is run only for a step that completed `success`** and declared a `compensate`. Recorded on the `steps` row at dispatch (`compensateFnPath`); the unwind filters on `state==="success" && compensateFnPath && !compensated`.
- **Halt on a failed compensation:** a compensation retries per its `maxAttempts` backoff; if it exhausts retries (`_compensateDone` gets `{kind:"failed"}`), the unwind HALTS — terminal `failed` with `"compensation failed at step N: …"` (preserving the original workflow error). NEVER silently continue past a failed rollback.
- **Cancel compensates by default:** `ctx.workflow.cancel(runId)` rolls back → terminal `canceled`; `cancel(runId, { compensate: false })` skips the unwind → terminal `canceled` immediately (today's behavior).
- **Sequential reverse-`stepNumber` unwind** (LIFO), even for fan-out steps. Parallel/group compensation is a NON-GOAL.
- **`generationNumber` OCC guard** on `_compensate`/`_compensateDone` exactly like `_advance`/`_stepDone` — a stale compensation callback (after a re-cancel/gen-bump) self-discards.
- **State model:** `running` → `compensating` (transient, observable in `workflow.status`) → terminal `failed` | `canceled`.
- **Additive:** a workflow with NO `compensate` options behaves exactly as today (terminal `failed` directly, no `compensating` phase). All existing workflow/scheduler tests stay green.
- **Test through the shipped entrypoint:** the feature gets an E2E through the real `stackbase dev` server (Task 4).
- TDD, frequent commits, each task ends green (`build`/`typecheck`/`test`). `noUncheckedIndexedAccess: true`.

Backing detail: `docs/superpowers/specs/2025-07-04-workflow-saga-design.md`.

---

## File Structure (all in the existing `components/workflow/`)

- `src/schema.ts` (**modify**) — `compensateFnPath?`/`compensated?` on `steps`; `compensationTarget?` on `workflows`.
- `src/replay.ts` (**modify**) — `compensate?: FnRef` in the `runMutation`/`runAction` options → resolved to `NewStepOpts.compensateFnPath`.
- `src/modules.ts` (**modify**) — record `compensateFnPath` at dispatch; the failed/cancel → `compensating` routing (a shared `failOrCompensate` helper); NEW `_compensate` + `_compensateDone`.
- `src/facade.ts` (**modify**) — `cancel(runId, opts?: { compensate?: boolean })` routing through compensation.
- `src/index.ts` (**modify**) — register `_compensate`/`_compensateDone`.
- `test/saga.test.ts` (**new**), `packages/cli/test/workflow-saga-e2e.test.ts` (**new**).

---

## Task 1: Record compensations — schema + the `compensate` step option

**Files:**
- Modify: `components/workflow/src/schema.ts`, `components/workflow/src/replay.ts`, `components/workflow/src/modules.ts`
- Test: `components/workflow/test/saga.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // replay.ts — step options gain compensate:
  //   runMutation<T>(ref, args?, opts?: { maxAttempts?: number; compensate?: FnRef }): Promise<T>
  //   runAction<T>(ref, args?, opts?: { maxAttempts?: number; compensate?: FnRef }): Promise<T>
  // NewStepOpts gains: compensateFnPath?: string   (resolved from opts.compensate via resolveRef)
  // schema: steps.compensateFnPath?: string, steps.compensated?: boolean; workflows.compensationTarget?: string
  ```

- [ ] **Step 1: Write the failing test** (`test/saga.test.ts`)

Use the existing `makeRuntimeWithWorkflow` helper (`components/workflow/test/helpers.ts`).
```ts
import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { workflow } from "@stackbase/workflow";
import { makeRuntimeWithWorkflow, readTable } from "./helpers";   // readTable used by other workflow tests

describe("saga — recording compensations", () => {
  it("a step declared with { compensate } stores compensateFnPath on its journal row", async () => {
    const flow = workflow.define({ handler: async (step: any) => {
      await step.runMutation("app:charge", { amt: 10 }, { compensate: "app:refund" });
      return "ok";
    }});
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      { "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:charge": mutation(async () => "charged"),
        "app:refund": mutation(async () => "refunded") },
      { "app:flow": flow });
    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); await tick();
    const steps = (await readTable(runtime, "workflow/steps")).filter((s: any) => s.workflowId === runId);
    const charge = steps.find((s: any) => s.name === "app:charge");
    expect(charge.compensateFnPath).toBe("app:refund");   // recorded
    expect(charge.state).toBe("success");
  });
});
```
> If `readTable`'s signature differs, mirror how `action-sleep.test.ts`/`occ-guard.test.ts` read `workflow/steps` rows.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test saga`
Expected: FAIL — `compensate` option not accepted / `compensateFnPath` undefined.

- [ ] **Step 3: Schema (`src/schema.ts`)**

In the `steps` table add `compensateFnPath: v.optional(v.string())` and `compensated: v.optional(v.boolean())`. In the `workflows` table add `compensationTarget: v.optional(v.string())` (the terminal state the unwind should reach: `"failed"` or `"canceled"`). `state` is already `v.string()`, so the new `"compensating"` value needs no schema change.

- [ ] **Step 4: Step option (`src/replay.ts`)**

Extend the `runMutation`/`runAction` option types in `StepApi` to `opts?: { maxAttempts?: number; compensate?: FnRef }` (add an `opts` param to `runMutation` — today it takes none). In `NewStepOpts` add `compensateFnPath?: string`. In `requestStep` (or wherever the step options are turned into a `NewStep`), resolve `opts.compensate` to a path and store it: `compensateFnPath: opts?.compensate !== undefined ? resolveRef(opts.compensate) : undefined` (reuse the existing `resolveRef`/`getFunctionPath` helper the file already uses for step names). Thread it into `NewStepOpts`.

- [ ] **Step 5: Record at dispatch (`src/modules.ts`)**

In `_advance`'s dispatch loop, add `compensateFnPath: ns.opts?.compensateFnPath` to the initial `ctx.db.insert(STEPS_TABLE, {...})` (the insert BEFORE the waitForEvent branch, so all kinds record it). Use the `compact`-style omission if the codebase omits `undefined` fields (grep how the insert handles optional fields — the schema is `v.optional`, so `undefined` is fine, but match the file's convention).

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test saga`
Expected: PASS (compensateFnPath recorded on the success step).

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (additive — no unwind yet; existing workflow tests unchanged).

```bash
git add components/workflow
git commit -m "feat(workflow): record per-step compensateFnPath (the compensate step option) — no unwind yet"
```

---

## Task 2: The unwind — `_compensate` + `_compensateDone` + failure→compensating

**This is the core.** Reverse-order compensation on a step failure.

**Files:**
- Modify: `components/workflow/src/modules.ts`, `components/workflow/src/index.ts`
- Test: `components/workflow/test/saga.test.ts`

**Interfaces:**
- Consumes: Task 1's `compensateFnPath`; the scheduler facade (`schedulerFacade(ctx).enqueue`), `OnCompleteResult`, `fireWorkflowOnComplete`.
- Produces:
  ```ts
  // modules.ts:
  //   _compensate     = mutation((ctx, {workflowId}) => null)        // the reverse-walk driver
  //   _compensateDone = mutation((ctx, {jobId, context:{workflowId,stepNumber,generationNumber}, result:OnCompleteResult}) => null)
  //   failOrCompensate(ctx, wf, originalError, target: "failed"|"canceled") — shared helper the failed branches call
  ```

- [ ] **Step 1: Write the failing test** (`test/saga.test.ts`)

```ts
it("a failing 3-step saga compensates steps 2 then 1 in reverse, each receiving {args,result}", async () => {
  const log: string[] = [];
  const flow = workflow.define({ handler: async (step: any) => {
    await step.runMutation("app:s1", { n: 1 }, { compensate: "app:c1" });
    await step.runMutation("app:s2", { n: 2 }, { compensate: "app:c2" });
    await step.runMutation("app:s3", { n: 3 });          // no compensation; this one throws
    return "unreached";
  }});
  const { runtime, tick } = await makeRuntimeWithWorkflow(
    { "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
      "app:s1": mutation(async (_c: any, a: any) => { log.push(`s1(${a.n})`); return "r1"; }),
      "app:s2": mutation(async (_c: any, a: any) => { log.push(`s2(${a.n})`); return "r2"; }),
      "app:s3": mutation(async () => { throw new Error("boom"); }),
      "app:c1": mutation(async (_c: any, a: any) => { log.push(`c1(args=${a.args.n},res=${a.result})`); return null; }),
      "app:c2": mutation(async (_c: any, a: any) => { log.push(`c2(args=${a.args.n},res=${a.result})`); return null; }) },
    { "app:flow": flow });
  const runId = (await runtime.run("app:kick", {})).value as string;
  for (let i = 0; i < 8; i++) await tick();
  const st = (await runtime.run("workflow:status", { runId })).value as any;
  expect(st.state).toBe("failed");
  expect(st.error).toMatch(/boom/);                        // original failure preserved
  expect(log).toEqual(["s1(1)", "s2(2)", "c2(args=2,res=r2)", "c1(args=1,res=r1)"]);  // reverse unwind, args+result passed
});

it("a failing saga with NO compensations fails directly (no compensating phase)", async () => {
  const states: string[] = [];
  const flow = workflow.define({ handler: async (step: any) => { await step.runMutation("app:s", {}); return "x"; }});
  const { runtime, tick } = await makeRuntimeWithWorkflow(
    { "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
      "app:s": mutation(async () => { throw new Error("nope"); }) },
    { "app:flow": flow });
  const runId = (await runtime.run("app:kick", {})).value as string;
  for (let i = 0; i < 5; i++) { await tick(); states.push((await runtime.run("workflow:status", { runId })).value.state); }
  expect(states).not.toContain("compensating");
  expect(states.at(-1)).toBe("failed");
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test saga`
Expected: FAIL — no compensation runs; status goes straight to `failed`, `log` lacks the `c2`/`c1` entries.

- [ ] **Step 3: The `failOrCompensate` helper + reroute the failed branches (`src/modules.ts`)**

Add a helper and call it from BOTH failed branches (the `outcome.kind === "failed"` branch ~line 170 AND the silent-stall failed branch ~line 187 — a determinism-violation failure should still roll back completed work):
```ts
async function failOrCompensate(ctx: any, wf: any, originalError: string, target: "failed" | "canceled"): Promise<void> {
  const steps = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", wf._id).collect()) as JournalRow[];
  const hasComp = steps.some((s) => s.state === "success" && s.compensateFnPath && !s.compensated);
  if (!hasComp) {
    // nothing to undo — terminal directly (unchanged behavior)
    const t = target === "canceled" ? "canceled" : "failed";
    await ctx.db.replace(wf._id, { ...wf, state: t, error: originalError, completedTs: ctx.now() });
    await fireWorkflowOnComplete(ctx, wf, target === "canceled" ? { kind: "canceled" } : { kind: "failed", error: originalError });
    return;
  }
  await ctx.db.replace(wf._id, { ...wf, state: "compensating", error: originalError, compensationTarget: target });
  await schedulerFacade(ctx).enqueue("workflow:_compensate", { workflowId: wf._id } as unknown as JSONValue, {});
}
```
Replace the failed-branch bodies (170-172 and 187-188) with `await failOrCompensate(ctx, fresh, <error>, "failed"); return null;` (keep the completed/success branch unchanged). (Note: `fireWorkflowOnComplete` today may not accept a `"canceled"` kind — extend it minimally to pass a `{kind:"canceled"}` `OnCompleteResult` through, matching the scheduler's `OnCompleteResult` union.)

- [ ] **Step 4: `_compensate` + `_compensateDone` (`src/modules.ts`) + register (`src/index.ts`)**

```ts
export const _compensate = mutation(async (ctx: any, a: { workflowId: string }): Promise<null> => {
  const wf = await ctx.db.get(a.workflowId);
  if (!wf || wf.state !== "compensating") return null;                 // terminal/superseded
  const gen = wf.generationNumber as number;
  const steps = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", a.workflowId).collect()) as JournalRow[];
  // highest stepNumber, success, has a compensation, not yet compensated
  const next = steps.filter((s) => s.state === "success" && s.compensateFnPath && !s.compensated)
                    .sort((x, y) => (y.stepNumber as number) - (x.stepNumber as number))[0];
  if (!next) {                                                          // unwind complete → terminal
    const target = (wf.compensationTarget as string) === "canceled" ? "canceled" : "failed";
    await ctx.db.replace(a.workflowId, { ...wf, state: target, completedTs: ctx.now() });
    await fireWorkflowOnComplete(ctx, wf, target === "canceled" ? { kind: "canceled" } : { kind: "failed", error: wf.error });
    return null;
  }
  const jobId = await schedulerFacade(ctx).enqueue(next.compensateFnPath as string,
    { args: next.args, result: next.result } as unknown as JSONValue,
    { onComplete: "workflow:_compensateDone",
      context: { workflowId: a.workflowId, stepNumber: next.stepNumber, generationNumber: gen } as unknown as JSONValue });
  await ctx.db.replace(next._id, { ...next, compensationJobId: jobId });  // for cascade-cancel; add field OR reuse a marker
  return null;
});

export const _compensateDone = mutation(async (ctx: any,
    a: { jobId: string; context: { workflowId: string; stepNumber: number; generationNumber: number }; result: OnCompleteResult }): Promise<null> => {
  const wf = await ctx.db.get(a.context.workflowId);
  if (!wf || wf.generationNumber !== a.context.generationNumber) return null;   // OCC guard
  const steps = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", a.context.workflowId).collect()) as JournalRow[];
  const row = steps.find((s) => s.stepNumber === a.context.stepNumber);
  if (!row) return null;
  if (a.result.kind === "success") {
    await ctx.db.replace(row._id, { ...row, compensated: true });
    await schedulerFacade(ctx).enqueue("workflow:_compensate", { workflowId: a.context.workflowId } as unknown as JSONValue, {});
  } else {
    // compensation itself failed → HALT (Task 3 tests this; the terminal-error text is finalized there)
    const cerr = a.result.kind === "failed" ? a.result.error : "canceled";
    await ctx.db.replace(a.context.workflowId, { ...wf, state: "failed", completedTs: ctx.now(),
      error: `compensation failed at step ${a.context.stepNumber}: ${cerr}; original workflow error: ${wf.error ?? ""}` });
    await fireWorkflowOnComplete(ctx, wf, { kind: "failed", error: `compensation failed at step ${a.context.stepNumber}` });
  }
  return null;
});
```
> `compensationJobId` — add it to the `steps` schema (`v.optional(v.string())`) OR reuse `scheduledJobId` (the forward job is terminal by the time we compensate, so `scheduledJobId` is free to reuse — pick one and be consistent; adding a distinct field is clearer for cancel's cascade in Task 3). Register `_compensate`/`_compensateDone` in `defineWorkflow`'s modules map (`src/index.ts`), next to `_advance`/`_stepDone`. `schedulerFacade(ctx)` / `STEPS_TABLE` / `JournalRow` / `fireWorkflowOnComplete` are the existing helpers in `modules.ts` — reuse them.

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test saga`
Expected: PASS (reverse unwind with args+result; no-compensation saga fails directly).

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add components/workflow
git commit -m "feat(workflow): reverse-order compensation unwind — _compensate/_compensateDone, failure enters compensating"
```

---

## Task 3: Failed-compensation halt · cancel compensates · crash-resume · fan-out order

**Files:**
- Modify: `components/workflow/src/facade.ts` (`cancel(runId, { compensate? })`), `components/workflow/src/modules.ts` (cancel's cascade to an in-flight compensation; finalize the halt error)
- Test: `components/workflow/test/saga.test.ts`

**Interfaces:**
- Consumes: Task 2's unwind.
- Produces: `ctx.workflow.cancel(runId, opts?: { compensate?: boolean })`.

- [ ] **Step 1: Write the failing test** (`test/saga.test.ts`)

Four tests:
```ts
it("a compensation that exhausts retries HALTS the unwind — terminal failed with a clear error", async () => {
  // s1 {compensate: c1-that-always-throws}, s2 {compensate: c2}, s3 throws.
  // unwind: c2 runs (success), c1 runs → fails all retries → workflow "failed",
  // error matches /compensation failed at step 0/ AND preserves /boom/ (original); c1's step NOT marked compensated;
  // (use a low maxAttempts on the compensation via the step's compensate — or the scheduler default; assert c2 ran, c1 attempted, unwind halted).
});
it("cancel(runId) mid-saga compensates then reaches canceled", async () => {
  // start a saga that parks (e.g. on a step you don't tick to completion, or a waitForEvent); cancel;
  // assert recorded compensations run and final state is "canceled".
});
it("cancel(runId, { compensate: false }) skips compensation — canceled immediately, no undo runs", async () => {
  // same setup; cancel with compensate:false; assert NO compensation ran and state "canceled".
});
it("fan-out steps compensate in reverse stepNumber order", async () => {
  // await Promise.all([step.a({compensate:ca}), step.b({compensate:cb})]) then a failing step;
  // assert cb then ca ran (reverse stepNumber), regardless of forward completion order.
});
```
(A crash-resume assertion — re-entering `_compensate` doesn't re-run an already-`compensated` step — is naturally covered by the mechanism; add a focused test if cheap: manually mark one step `compensated`, enqueue `_compensate`, assert that step's compensation does NOT run again.)

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/workflow test saga`
Expected: FAIL — `cancel` doesn't accept opts / doesn't compensate.

- [ ] **Step 3: `cancel(runId, { compensate? })` (`src/facade.ts`)**

Extend `cancel` to `cancel(runId, opts?: { compensate?: boolean })` (both the `WorkflowContext` type and the impl). Behavior: read the workflow row; bump `generationNumber`; cascade-cancel in-flight FORWARD step jobs (existing behavior). Then:
- if `opts?.compensate === false` OR no recorded compensations → set `state:"canceled"`, `completedTs`, fire `onComplete{canceled}` (today's terminal path).
- else → `await failOrCompensate(ctx, <the row WITH the bumped gen>, "canceled (by request)", "canceled")` — enters `compensating` with target `canceled`. IMPORTANT: read/replace the row so the bumped `generationNumber` is the one `_compensate` captures (a later re-cancel bumps again → in-flight `_compensateDone` self-discards).
> `failOrCompensate` lives in `modules.ts`; either export it for the facade, or replicate the small compensating-entry write in the facade (enqueue `workflow:_compensate` after setting `state:"compensating"`, `compensationTarget:"canceled"`, `error:"canceled (by request)"`). Keep ONE source of truth — prefer exporting the helper.

- [ ] **Step 4: Cancel's cascade to an in-flight compensation (`src/modules.ts`/`facade.ts`)**

If a workflow is ALREADY `compensating` and gets canceled again, the gen-bump makes the in-flight `_compensateDone` self-discard (OCC guard) — verify this holds (it should, since `_compensateDone` checks `generationNumber`). Also cascade-cancel an in-flight compensation job if one is dispatched: cancel should call `ctx.scheduler.cancel(compensationJobId)` for the step currently being compensated (the one with a `compensationJobId` and not yet `compensated`). Add this to the cancel cascade. Finalize the halt-error text in `_compensateDone` (Task 2 stubbed it) to match the test's `/compensation failed at step N/` + original-error preservation.

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/workflow test saga`
Expected: PASS (halt on failed compensation; cancel compensates; opt-out; fan-out reverse order).

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add components/workflow
git commit -m "feat(workflow): halt-on-failed-compensation, cancel-compensates (+opt-out), fan-out reverse-order unwind"
```

---

## Task 4: E2E through the shipped server + docs

**Files:**
- Test: `packages/cli/test/workflow-saga-e2e.test.ts` (new)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Tasks 1-3 end-to-end.

- [ ] **Step 1: Write the failing E2E** (`packages/cli/test/workflow-saga-e2e.test.ts`)

Mirror `packages/cli/test/workflow-e2e.test.ts` (real `startDevServer`/`loadProject` + real WS). Prove the reverse unwind through the shipped server:
```ts
// project: a saga app:orderFlow = step.runMutation(app:charge, { compensate: app:refund }) then step.runMutation(app:failStep) [throws];
//   app:refund writes a row (e.g. inserts into a "refunds" table or sets a flag). Plus app:kick (ctx.workflow.start) + a live status query.
// 1. startDevServer; WS client; app:kick over WS → runId.
// 2. subscribe workflow:status; assert it passes through "compensating" and reaches "failed" (bounded ~10s waitFor).
// 3. assert the refund's effect is visible (query the "refunds" row via admin browse /_admin/tables/.../data) — the compensation actually ran through the real reactive loop.
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test workflow-saga-e2e`
Expected: FAIL initially; passes once Tasks 1-3 are wired. If it exposes a real shipped-server wiring gap (e.g. `_compensate`/`_compensateDone` not registered in the composed dev server), FIX it (root cause) — do NOT weaken assertions.

- [ ] **Step 3: Make it pass**

Should pass on Tasks 1-3. If a gap surfaces, fix at root cause.

- [ ] **Step 4: Docs (`CLAUDE.md`)**

Update the `@stackbase/workflow` bullet: saga/compensation now shipped — per-step `compensate` handlers, reverse-order unwind on failure (and on compensating cancel), halt-on-failed-compensation. Move saga OUT of the "deferred to v1.1" note (leaving sub-workflows + replay-debugging still deferred). Keep it accurate — do NOT claim sub-workflows or nested scopes.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add packages/cli/test/workflow-saga-e2e.test.ts CLAUDE.md
git commit -m "test(workflow): saga E2E through the dev server (running→compensating→failed, refund effect visible); docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §2.1 per-step compensate → T1. §2.2 compensation receives {args,result} → T2 (the enqueue passes `{args:next.args, result:next.result}`). §2.3 cancel compensates + opt-out → T3. §2.4 halt on failed compensation → T2 (stub) + T3 (finalized + tested). §2.5 reverse-stepNumber unwind → T2 (the sort) + T3 (fan-out test). §2.6 state model (running→compensating→terminal) → T2. §3 API → T1. §4 mechanism (record/trigger/unwind) → T1/T2. §5 schema → T1 (+ compensationJobId noted in T2). §6 crash-resume + gen guard → T2 (`compensated` skip, OCC guard) + T3 (crash-resume test). §7 testing → each task + E2E T4. §8 files → matches. §9 non-goals (parallel/group, nested scopes, sub-workflows) → not built. ✅

**Placeholder scan:** No TBD/TODO. Deliberate "recipe-not-transcription" spots (flagged): the exact terminal-error text (T2 stubs it, T3 finalizes to match the test regex), whether to reuse `scheduledJobId` vs add `compensationJobId` (told to pick one consistently — a distinct field is clearer for cancel's cascade), the `readTable` signature (told to mirror sibling tests). Each names a concrete existing pattern.

**Type consistency:** `compensateFnPath: string` consistent schema (T1) → `_advance` record (T1) → `_compensate` read (T2). `NewStepOpts.compensateFnPath` from `opts.compensate:FnRef` via `resolveRef` (T1). `_compensate`/`_compensateDone` arg shapes mirror `_advance`/`_stepDone` (`{workflowId}` / `{jobId, context:{workflowId,stepNumber,generationNumber}, result:OnCompleteResult}`) — matches the scheduler's `fireOnComplete` enqueue (verified). `compensationTarget: "failed"|"canceled"` consistent schema (T1) → `failOrCompensate` write (T2) → `_compensate` terminal read (T2). `failOrCompensate(ctx, wf, error, target)` consistent T2 (define + failed branches) → T3 (cancel). `cancel(runId, {compensate?})` consistent facade type + impl (T3). ✅

**Scope note:** `fireWorkflowOnComplete` must accept a `{kind:"canceled"}` `OnCompleteResult` (T2 flags the minimal extension). The `compensationJobId` cascade on a mid-compensation cancel (T3 Step 4) is the subtlest bit — a re-cancel during compensation relies on the gen-bump + OCC self-discard as the primary guard, with the job-cascade as cleanup; if the implementer finds the cascade redundant given the OCC guard, that's a reviewer discussion, not a silent drop. Fan-out compensation is sequential reverse-stepNumber (a NON-GOAL is parallel/group compensation — do not build it).
