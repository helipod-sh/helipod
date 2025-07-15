import { defineSchema, defineTable, v } from "@stackbase/values";

/**
 * The `@stackbase/workflow` component schema (namespaced `workflow/*` when composed).
 *
 * - `workflows`: one row per `ctx.workflow.start(...)` call — the journal's root. `state` starts
 *   `"running"`; Task 2's replay loop drives it to `"completed"`/`"failed"`. `generationNumber`
 *   is the replay-from-scratch counter (bumped each time `_advance` re-executes the handler from
 *   step 0 to reach the next not-yet-durable step — see the design spec). `onComplete`/`context`
 *   mirror the scheduler's workflow-ready round-trip primitives (`fireOnComplete` in
 *   `@stackbase/scheduler`), reserved here for the workflow-of-workflows slice.
 * - `steps`: the durable step journal — one row per step a workflow's handler has (or is)
 *   executing, keyed by `(workflowId, stepNumber)`. `kind` distinguishes step flavors (e.g.
 *   `"runMutation"`/`"runAction"`/`"sleep"`/`"waitForEvent"`) added as Task 2+ builds out the
 *   replay loop's `step` object.
 * - `events`: external signals delivered into a running workflow (`ctx.workflow`'s
 *   `sendEvent`/a workflow's `step.waitForEvent`, wired in a later task) — kept here now so the
 *   schema is stable across tasks rather than migrated later.
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
  }).index("by_workflow", ["workflowId", "stepNumber"]),

  events: defineTable({
    workflowId: v.string(),
    name: v.string(),
    payload: v.optional(v.any()),
    state: v.string(),
    createdTs: v.number(),
  }).index("by_workflow_name", ["workflowId", "name"]),
});
