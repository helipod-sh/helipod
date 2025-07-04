import { query, mutation } from "@stackbase/executor";
import type { QueryCtx, MutationCtx } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { JobState, SignalKind } from "./facade";

/**
 * Internal modules for `@stackbase/scheduler` — registered on `defineScheduler()`'s `modules` map
 * (so they're reachable as `scheduler:_peekDue` / `scheduler:_claim` / `scheduler:_complete`),
 * consumed ONLY by the Task 3 driver loop (`./driver.ts`) via `DriverContext.runFunction`, which
 * always calls privileged (`runtime-embedded/src/runtime.ts`'s `driverCtx.runFunction` sets
 * `privileged: true`). Privileged calls bypass namespace prefixing entirely (`kernel.ts`'s
 * `requireTable`), so — unlike `facade.ts`, which runs namespaced and uses bare table names
 * (`"jobs"`, `"job_args"`) — these modules must use the fully-qualified names
 * (`"scheduler/jobs"`, `"scheduler/job_args"`, `"scheduler/signals"`).
 *
 * `_peekDue`/`_claim`/`_complete` are internal by convention (the `_` prefix + being paired only
 * with the driver), not by enforced access control — see Task 3's research notes. That's an
 * accepted gap for this slice (nothing else in the codebase enforces "driver-only" beyond
 * `_system:*`/`_admin:*`'s separate privileged registries).
 */

/** Cap on how many due jobs a single `_peekDue` batch returns, so one loop iteration can't run unbounded. */
export const BATCH_CAP = 64;

/** How long a claim's lease is valid before it could be reclaimed. Retry/reclaim-on-expiry is Task 4; this slice only stamps it. */
export const LEASE_MS = 30_000;

/** Mirrors `facade.ts`'s `segmentOf` — buckets wall-clock ms into 100ms windows for `signals.by_segment`. */
function segmentOf(ms: number): number {
  return Math.floor(ms / 100);
}

/** Drop `undefined`-valued keys before a `db.replace` (the wire codec rejects `undefined`; omit rather than null it out). Mirrors `facade.ts`'s `compact`. */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

export interface DueJob {
  _id: string;
  fnPath: string;
  kind: "mutation" | "action";
  state: JobState;
  nextTs: number;
  [key: string]: unknown;
}

export interface PeekDueResult {
  due: DueJob[];
  earliestFutureTs: number | null;
}

/**
 * `scheduler:_peekDue` — a QUERY (snapshot read, no writes). Scans `jobs`' `by_next_ts` index
 * (`["state", "nextTs"]`) for `state:"pending"`: `due` = rows with `nextTs <= now` (ascending,
 * capped at `BATCH_CAP`), `earliestFutureTs` = the smallest `nextTs > now` among the rest — so the
 * driver can re-arm its wake timer precisely instead of polling.
 */
export const _peekDue = query(async (ctx: QueryCtx): Promise<PeekDueResult> => {
  const now = ctx.now();
  const due = await ctx.db
    .query("scheduler/jobs", "by_next_ts")
    .eq("state", "pending")
    .lte("nextTs", now)
    .order("asc")
    .take(BATCH_CAP)
    .collect();
  const future = await ctx.db
    .query("scheduler/jobs", "by_next_ts")
    .eq("state", "pending")
    .gt("nextTs", now)
    .order("asc")
    .take(1)
    .collect();
  const next = future[0];
  return {
    due: due as unknown as DueJob[],
    earliestFutureTs: next ? (next.nextTs as number) : null,
  };
});

export interface ClaimResult {
  jobId: string;
  fnPath: string;
  kind: "mutation" | "action";
  args: JSONValue;
  context: JSONValue | undefined;
  onComplete: string | undefined;
}

/**
 * `scheduler:_claim` — a MUTATION: re-reads the job by id and transitions `pending → inProgress`
 * ONLY if it is still exactly `state:"pending"` (a snapshot-read + exact-match guard). Returns
 * `null` if the job is missing or was already claimed/canceled by someone else — the caller
 * (the driver loop) skips it. The single-writer OCC transactor serializes concurrent `_claim`
 * calls on the same job, so this check is the AUTHORITATIVE double-run guard: at most one caller
 * ever observes `state==="pending"` for a given job.
 */
export const _claim = mutation(async (ctx: MutationCtx, args: { jobId: string }): Promise<ClaimResult | null> => {
  const job = await ctx.db.get(args.jobId);
  if (job === null || job.state !== "pending") return null; // gone, or already claimed — lost the race
  const now = ctx.now();
  await ctx.db.replace(args.jobId, {
    ...job,
    state: "inProgress" as JobState,
    leaseHolder: "driver",
    leaseExpiresAt: now + LEASE_MS,
  });
  const argRows = await ctx.db.query("scheduler/job_args", "by_job").eq("jobId", args.jobId).take(1).collect();
  const argRow = argRows[0];
  return {
    jobId: args.jobId,
    fnPath: job.fnPath as string,
    kind: job.kind as "mutation" | "action",
    args: (argRow?.args ?? null) as JSONValue,
    context: argRow?.context as JSONValue | undefined,
    onComplete: job.onComplete as string | undefined,
  };
});

export type JobResult = { kind: "success"; value: unknown } | { kind: "failed"; error: string };

/**
 * `scheduler:_complete` — a MUTATION: finalizes a claimed job. Sets the terminal `state`
 * (`success`/`failed` — retry/backoff on failure is Task 4; here a failure goes straight to
 * `failed`), stamps `completedTs`, and clears the lease (`leaseHolder`/`leaseExpiresAt` — the
 * "dispatch key" `_claim` set) since the job is no longer in flight. Appends a `complete` signal
 * carrying the outcome so a test (or, later, a UI) can observe it without re-reading `jobs`.
 *
 * No-ops (returns `null`) if the job vanished or isn't `inProgress` — defensive against a stray
 * double-complete; `_claim`'s guard is what actually prevents double-dispatch.
 */
export const _complete = mutation(async (ctx: MutationCtx, args: { jobId: string; result: JobResult }): Promise<null> => {
  const job = await ctx.db.get(args.jobId);
  if (job === null || job.state !== "inProgress") return null;
  const now = ctx.now();
  const state: JobState = args.result.kind === "success" ? "success" : "failed";
  await ctx.db.replace(
    args.jobId,
    compact({
      ...job,
      state,
      completedTs: now,
      leaseHolder: undefined,
      leaseExpiresAt: undefined,
    }),
  );
  await ctx.db.insert("scheduler/signals", {
    segment: segmentOf(now),
    kind: "complete" as SignalKind,
    jobId: args.jobId,
    payload: args.result as unknown as JSONValue,
  });
  // TODO(Task 6): if (job.onComplete) enqueue the completion callback —
  // `ctx.scheduler.runAfter(0, job.onComplete as string, { jobId: args.jobId, result: args.result })`.
  // The payload contract (what shape `context`/`result` the onComplete callback receives) is
  // Task 6's to define; not implemented here.
  return null;
});
