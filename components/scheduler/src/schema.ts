import { defineSchema, defineTable, v } from "@stackbase/values";

/**
 * The `@stackbase/scheduler` component schema (namespaced `scheduler/*` when composed).
 *
 * - `jobs` / `job_args`: split so a job's identity/state (small, hot — scanned by the driver's
 *   `by_next_ts` index) never carries the (possibly large) `args`/`context` payload.
 * - `crons`: declared here for the schema to be stable across Task 2→5; only Task 5's cron
 *   scheduler reads/writes it (`cadenceJobId` links a cron to its currently-pending job).
 * - `signals`: an append-only wake log. Every `enqueue`/`complete`/`cancel` appends a row so the
 *   Task 3 driver loop can wake precisely (via `by_segment`) instead of polling `jobs` blindly.
 */
export const schedulerSchema = defineSchema({
  jobs: defineTable({
    fnPath: v.string(),
    kind: v.union(v.literal("mutation"), v.literal("action")),
    state: v.union(
      v.literal("pending"),
      v.literal("inProgress"),
      v.literal("success"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    nextTs: v.number(),
    attempts: v.number(),
    maxFailures: v.number(),
    leaseHolder: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    appVersion: v.optional(v.string()),
    name: v.optional(v.string()),
    hasArgs: v.boolean(),
    onComplete: v.optional(v.string()),
    parentId: v.optional(v.string()),
    completedTs: v.optional(v.number()),
    /** The most recent failure's `String(error)` — set on retry AND on dead-letter (Task 4). */
    lastError: v.optional(v.string()),
  })
    .index("by_next_ts", ["state", "nextTs"])
    .index("by_completed_ts", ["completedTs"])
    .index("by_parent", ["parentId"]),

  job_args: defineTable({
    jobId: v.string(),
    args: v.any(),
    context: v.optional(v.any()),
  }).index("by_job", ["jobId"]),

  // Task 5: recurring/cron schedules. `cadenceJobId` points at the currently-pending `jobs` row
  // for this cron (if any); the driver reschedules the next occurrence on completion.
  crons: defineTable({
    name: v.string(),
    spec: v.string(),
    tz: v.string(),
    catchUp: v.boolean(),
    lastScheduledTs: v.optional(v.number()),
    workFnPath: v.string(),
    workArgs: v.any(),
    cadenceJobId: v.optional(v.string()),
  }).index("by_name", ["name"]),

  signals: defineTable({
    segment: v.number(),
    kind: v.union(v.literal("enqueue"), v.literal("complete"), v.literal("cancel")),
    jobId: v.string(),
    payload: v.optional(v.any()),
  }).index("by_segment", ["segment"]),
});
