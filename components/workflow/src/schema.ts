import { defineSchema, defineTable, v } from "@stackbase/values";

/**
 * The `@stackbase/workflow` component schema (namespaced `workflow/*` when composed).
 *
 * - `workflows`: one row per `ctx.workflow.start(...)` call — the journal's root. `state` starts
 *   `"running"`; Task 2's replay loop drives it to `"completed"`/`"failed"` (the saga slice adds a
 *   `"compensating"` value, no schema change needed since `state` is already `v.string()`).
 *   `generationNumber` is the replay-from-scratch counter (bumped each time `_advance` re-executes
 *   the handler from step 0 to reach the next not-yet-durable step — see the design spec).
 *   `onComplete`/`context` mirror the scheduler's workflow-ready round-trip primitives
 *   (`fireOnComplete` in `@stackbase/scheduler`), reserved here for the workflow-of-workflows
 *   slice. `compensationTarget` (saga slice, Task 2+) is the terminal state (`"failed"` or
 *   `"canceled"`) the unwind should reach once compensation finishes — recorded but unused until
 *   the unwind loop is built.
 * - `steps`: the durable step journal — one row per step a workflow's handler has (or is)
 *   executing, keyed by `(workflowId, stepNumber)`. `kind` distinguishes step flavors (e.g.
 *   `"runMutation"`/`"runAction"`/`"sleep"`/`"waitForEvent"`) added as Task 2+ builds out the
 *   replay loop's `step` object. `compensateFnPath` (saga slice) is the resolved path of the
 *   step's `{ compensate }` option, if any, stamped onto the row at dispatch (`./modules.ts`'s
 *   `_advance`) — recorded for every step kind but not yet acted on (Task 2 of the saga slice
 *   builds the reverse-order unwind that reads it). `compensated` marks whether the unwind has
 *   already run this step's compensation (also unused until Task 2). `compensationJobId` (Task 2)
 *   is the scheduler job id of the DISPATCHED compensation itself (distinct from `scheduledJobId`,
 *   which is the original forward step's job — terminal by the time compensation runs, so reusing
 *   it would conflate two different jobs) — stamped by `_compensate` so a future cancel cascade
 *   (Task 3) can cancel an in-flight compensation the same way it cancels a pending forward step.
 * - `events`: external signals delivered into a running workflow — one row per `step.waitForEvent`
 *   call, `state:"waiting"` until `ctx.workflow.sendEvent(runId, name, payload)` flips it
 *   `"received"` (Task 6, `./events.ts`/`./facade.ts`).
 * - `config`: a single-row tuning table, optional for Task 1 (deferred — no row is written or
 *   read yet); reserved for `maxJournalSteps`/`maxRecoveryAttempts` once the replay loop needs them.
 */
export const workflowSchema = defineSchema({
  workflows: defineTable({
    workflowFnPath: v.string(),
    args: v.any(),
    state: v.string(),
    generationNumber: v.number(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    onComplete: v.optional(v.string()),
    context: v.optional(v.any()),
    recoveryAttempts: v.number(),
    startedTs: v.number(),
    completedTs: v.optional(v.number()),
    compensationTarget: v.optional(v.string()),
  }).index("by_state", ["state"]),

  steps: defineTable({
    workflowId: v.string(),
    stepNumber: v.number(),
    name: v.string(),
    kind: v.string(),
    args: v.any(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    state: v.string(),
    scheduledJobId: v.optional(v.string()),
    startedTs: v.number(),
    completedTs: v.optional(v.number()),
    compensateFnPath: v.optional(v.string()),
    compensated: v.optional(v.boolean()),
    compensationJobId: v.optional(v.string()),
  }).index("by_workflow", ["workflowId", "stepNumber"]),

  events: defineTable({
    workflowId: v.string(),
    name: v.string(),
    payload: v.optional(v.any()),
    state: v.string(),
    createdTs: v.number(),
  }).index("by_workflow_name", ["workflowId", "name"]),
});
