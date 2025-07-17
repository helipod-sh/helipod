# `@stackbase/workflow` — saga / compensation design

**Status:** approved (brainstorming) — 2025-07-04
**Slice:** the workflow v1.1 differentiator. Extends the shipped `@stackbase/workflow` (merge `bffbae7`). Adds declarative per-step compensation (rollback), the feature the research flagged as *more complete* than Temporal/Restate's manual try/catch pattern.
**Research:** `components/workflow/docs/architecture-notes.md §5` ("a step declared with a `compensate` handler … on failure, an unwind pass replays the journal in reverse … builds entirely on the existing step machinery") + `.reference/workflow-research/lunora-cloudflare-and-market.md §4.2`.
**Predecessor context:** The workflow component ships a durable step journal (`steps` rows: `{workflowId, stepNumber, name, kind, args, result, state, scheduledJobId}`), a replay loop (`_advance` runs the handler; new steps dispatch via `ctx.scheduler.enqueue(..., {onComplete:"workflow:_stepDone", context})`; the handler suspends; `_stepDone` journals the result + re-enqueues `_advance`), a `generationNumber` OCC advance guard, and — the hook for saga — a failure path where `_advance` today sets `state:"failed"` + fires `onComplete{failed}` (`modules.ts:170-172`). Cancel bumps the generation + cascades cancel to in-flight step jobs.

---

## 1. Goal

Declarative saga/compensation: an author attaches an **undo handler** to a side-effecting step; if the workflow later fails (or is canceled), the recorded compensations run **in reverse order**, durably. The classic use: an order flow that charges a card, then fails at shipping, automatically refunds the charge — with no hand-rolled try/catch. Compensation reuses the existing durable-step machinery, so it survives crashes and retries exactly like forward execution.

**The one concept: saga is the reverse traversal of the journal.** Forward replay walks the journal start→end dispatching new steps; compensation walks the same journal end→start dispatching each successful step's recorded undo-handler. The compensation phase is itself journaled + scheduler-dispatched, so it is crash-durable and retried. No new engine primitive.

---

## 2. Locked decisions (from brainstorming)

1. **Per-step `compensate` option** — the undo handler is declared on the step it reverses (`step.runAction(ref, args, { compensate: undoRef })`), NOT registered imperatively or via a scope wrapper. The saga is implicit: any failure triggers a reverse-order unwind of every compensation recorded so far.
2. **The compensation handler receives `{ args, result }` of the original step** (so it knows what to undo). It is an ordinary mutation/action, dispatched as its own durable step.
3. **Cancel compensates by default.** `ctx.workflow.cancel(runId)` rolls back recorded compensations, then reaches terminal `canceled`. `cancel(runId, { compensate: false })` skips the unwind (today's immediate-stop behavior).
4. **Halt on a failed compensation.** A compensation retries per its backoff; if it exhausts retries, the unwind HALTS and the workflow goes terminal `failed` with a clear `"compensation failed at step N"` error. We never silently continue past a failed rollback.
5. **Sequential reverse-`stepNumber` unwind** (LIFO), even for steps that ran in parallel (fan-out). Parallel/group compensation is a non-goal (tied to the deferred sub-workflows).
6. **State model:** `running` → `compensating` (transient, observable in `status`) → terminal `failed` | `canceled`.
7. **Scope:** per-step compensation + reverse unwind + compensating cancel. **Non-goals:** parallel/group compensation of fan-out branches, nested saga scopes, sub-workflows (still deferred), replay-debugging.

---

## 3. API — the `compensate` step option

```ts
const charge = await step.runAction(api.payments.charge, { orderId },
  { maxAttempts: 3, compensate: api.payments.refund });   // undo handler recorded when this step succeeds
const rec = await step.runMutation(api.orders.markPaid, { orderId, charge },
  { compensate: api.orders.markUnpaid });
await step.runAction(api.shipping.create, { orderId });     // ...throws
// → workflow enters "compensating":
//     refund   receives { args: { orderId }, result: charge }
//     markUnpaid receives { args: { orderId, charge }, result: rec }
//   run in reverse; then terminal "failed" with shipping's error.
```

- `compensate?: FnRef` is added to the options of `runMutation`/`runAction` (the side-effecting kinds). `compensate` on `runQuery`/`sleep`/`waitForEvent` is accepted (uniform API) but those steps rarely need it — they have nothing to undo.
- The compensation is recorded on the step's `steps` row (`compensateFnPath`) **only when the step completes `success`**. A step that failed, was canceled, or never ran has nothing to undo.
- The compensation's args are `{ args, result }` of the original step — a stable, JSON-safe payload journaled with the compensation step.

---

## 4. The mechanism (three touch-points, one new loop)

**(a) Forward — record the compensation.** In `_advance`'s new-step dispatch, when a step declares `compensate`, store `compensateFnPath` on the `steps` row alongside the existing fields. No other change to replay. `StepApi`/`NewStep`/`NewStepOpts` gain `compensate?: FnRef` / `compensateFnPath?: string`.

**(b) Trigger — route failure/cancel into compensation.** Where `_advance` today handles `outcome.kind === "failed"` by setting `state:"failed"`, it instead:
- computes whether any recorded compensation exists (a `success` step with `compensateFnPath` not yet compensated);
- if YES → set `state:"compensating"`, preserve the original `error` (stored e.g. in `error` or a dedicated field), remember the terminal target (`failed`), and enqueue `workflow:_compensate`;
- if NO → terminal `failed` directly (nothing to undo), fire `onComplete{failed}` — unchanged from today.
`ctx.workflow.cancel(runId)` (default): bump `generationNumber`, cascade-cancel in-flight forward step jobs (existing behavior), then — if compensations exist — set `state:"compensating"` with terminal target `canceled` and enqueue `_compensate`; if none (or `{compensate:false}`) → terminal `canceled` directly.

**(c) Unwind — `_compensate` + `_compensateDone` (the new durable loop).** This is NOT handler-replay (the handler already failed; re-running it would re-throw). It's a dedicated reverse walk:
- `_compensate` (internal mutation, arg `{workflowId}`): re-read the workflow row; if `state !== "compensating"` no-op (terminal/superseded). Find the **highest-`stepNumber`** `success` step that has `compensateFnPath` set and is NOT yet `compensated`. If none → the unwind is complete: set the workflow terminal (`failed` with the preserved original error, or `canceled`), `completedTs`, fire `onComplete`. If one is found → dispatch its compensation via `ctx.scheduler.enqueue(compensateFnPath, { args: step.args, result: step.result }, { retry: {maxFailures}, onComplete: "workflow:_compensateDone", context: { workflowId, stepNumber, generationNumber } })`, record the compensation's `scheduledJobId` (for cascade-cancel), and return.
- `_compensateDone` (the onComplete callback, arg `{jobId, context:{workflowId,stepNumber,generationNumber}, result: OnCompleteResult}`): generationNumber OCC guard (stale → no-op, like `_stepDone`). If `result.kind === "success"` → mark the original step `compensated: true`, re-enqueue `_compensate` (next in reverse order). If `result.kind === "failed"` (the compensation itself exhausted retries) → **HALT**: set the workflow terminal `failed` with `error: "compensation failed at step N: <compensation error>"`, `completedTs`, fire `onComplete{failed}`. Do not continue the unwind.

The commit fan-out wakes the driver at each `_compensate`/`_compensateDone` commit, so the unwind advances reactively with no polling — identical to forward advance.

---

## 5. Schema changes (`steps` row + workflow state)

- `steps`: add `compensateFnPath?: v.optional(v.string())` (the declared undo, recorded on `success`) and `compensated?: v.optional(v.boolean())` (set true once its compensation has run). The `by_workflow [workflowId, stepNumber]` index already gives the reverse walk its ordering (iterate descending).
- `workflows`: the `state` field gains the value `"compensating"` (transient). Preserve the failure's original error across the compensating phase (reuse `error`, or add `pendingError?` if `error` must stay clean until terminal — implementer's choice; the terminal state must surface the ORIGINAL failure error, plus a compensation-failure note if the unwind halted). Add a small marker for the terminal target (`failed` vs `canceled`) the unwind should reach — e.g. a `compensationTarget?: v.optional(v.string())` field, or infer it (cancel sets `canceled`, a step-failure sets `failed`).

## 6. Interactions & guarantees

- **Crash-durability of the unwind:** re-entering `_compensate` after a process crash re-reads the journal; steps already marked `compensated` are skipped → no double-undo. A compensation dispatched but whose `_compensateDone` hadn't committed is reclaimed by the scheduler (mutation compensations exactly-once; action compensations at-most-once — a crashed action compensation is dead-lettered → `_compensateDone{failed}` → the unwind halts, surfacing the incomplete rollback).
- **generationNumber guard:** `_compensate`/`_compensateDone` carry + check the generation exactly like `_advance`/`_stepDone`. A cancel during compensation bumps the generation → in-flight `_compensateDone` self-discards.
- **Fan-out:** parallel forward steps compensate in reverse `stepNumber` order (sequential).
- **waitForEvent/sleep:** skipped by the reverse walk (no `compensateFnPath`).
- **No compensations:** a failing saga with zero recorded compensations behaves exactly as today (terminal `failed`, no `compensating` phase).
- **Reactive status:** `workflow.status` returns `compensating` during the unwind — a live dashboard/client sees the rollback in progress.

## 7. Testing

- **Unit (`components/workflow/test/saga.test.ts`):**
  - A 3-step saga where step 3 throws → steps 2 then 1 compensate in reverse; each compensation receives `{args, result}` of its step; terminal `failed` with step 3's error.
  - A compensation that itself fails (exhausts retries) → workflow terminal `failed` with `"compensation failed at step N"`; the unwind halted (later-in-reverse compensations that already ran stayed done; earlier ones did NOT run).
  - `cancel(runId)` mid-saga → compensations run → terminal `canceled`.
  - `cancel(runId, { compensate: false })` → no compensation, terminal `canceled` immediately.
  - Crash mid-unwind (simulate: a compensation step left in-flight, re-enter `_compensate`) → resumes, a `compensated` step is not re-run (no double-undo).
  - Fan-out (`Promise.all([a,b])` then a failing step) → b and a compensate in reverse `stepNumber`.
  - A saga with no `compensate` options that fails → terminal `failed` directly, no `compensating` state ever observed.
- **E2E through the shipped `stackbase dev` server (`packages/cli/test/workflow-saga-e2e.test.ts`):** a client starts a saga (a `runMutation` step with a `compensate` + a step that fails); `workflow.status` transitions `running → compensating → failed` over the live subscription; the compensation's effect (e.g. a row it wrote/reverted) is visible via admin browse — proving the reverse unwind reactively end-to-end.
- **Regression:** all existing workflow tests (replay/occ-guard/action-sleep/fanout/wait-event/action-workflow/workflow-e2e) + scheduler suite green — the `compensate` option is additive; a workflow with no compensations is unchanged.

## 8. File structure

- **Modify:** `components/workflow/src/replay.ts` (`compensate?` in step options → `NewStep`), `src/modules.ts` (record `compensateFnPath` on dispatch; the failed/cancel → `compensating` routing; new `_compensate` + `_compensateDone`), `src/facade.ts` (`cancel(runId, { compensate? })`; cancel's compensating routing), `src/schema.ts` (`compensateFnPath`/`compensated` on `steps`, the `compensating` state + terminal-target marker), `src/index.ts` (register `_compensate`/`_compensateDone`).
- **New:** `components/workflow/test/saga.test.ts`, `packages/cli/test/workflow-saga-e2e.test.ts`.
- **Docs:** `CLAUDE.md` (saga/compensation now shipped; move it out of the workflow "deferred to v1.1" note); a saga example in `examples/auth-demo/stackbase.config.ts` if it clarifies the pattern.

## 9. Out of scope (non-goals)

Parallel/group compensation of fan-out branches (compensate a whole parallel group together — needs sub-workflows); nested saga scopes / partial-scope compensation; re-run-after-compensation (retrying the forward path after a rollback — a workflow-level retry policy, separate); compensation of `waitForEvent`/`sleep`/`query` steps beyond the uniform (usually-unused) option; sub-workflows and replay-debugging (remain v1.1+ deferred).
