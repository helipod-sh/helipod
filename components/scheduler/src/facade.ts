import type { ComponentContext } from "@stackbase/executor";
import { GuestDatabaseWriter } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";

/**
 * A function reference as produced by codegen's `api`/`internal` proxy (see
 * `@stackbase/client`'s `FunctionReference`/`getFunctionPath`). Replicated here (rather than
 * depending on `@stackbase/client`, a client-facing SDK package) since a server component
 * needs only this one-field shape.
 */
export interface FunctionReference {
  readonly __path: string;
}

export type FnRef = FunctionReference | string;

/** Resolve a `fnRef` (string path or codegen ref) to its string path. Mirrors `@stackbase/client`'s `getFunctionPath`. */
function getFunctionPath(ref: FnRef): string {
  return typeof ref === "string" ? ref : ref.__path;
}

/**
 * Task 4 design note — `parentId` threading (cascading cancel):
 *
 * The original design was for the driver to set an ambient "current job id" while running a job,
 * so a job scheduling a child (`ctx.scheduler.runAfter(...)` called from inside a driver-run job)
 * would have that child's `parentId` populated automatically via `currentJobId()` below. That
 * requires the ambient to survive from `driver.ts`'s `runPass()` — which only has the string
 * `fnPath`/`jobId`, and calls `ctx.runFunction(claimed.fnPath, claimed.args)` — through
 * `DriverContext.runFunction` → `InlineUdfExecutor.run` → this component's `context` builder,
 * none of which currently carry a "who's calling" field. Wiring it soundly means extending
 * `DriverContext.runFunction`'s signature, `RunOptions` (`packages/executor/src/executor.ts`),
 * and `ComponentContext` (used by every `context:` facade, not just this one) — a cross-package
 * change well outside `components/scheduler/*` with blast radius on every component, for a single
 * driver's benefit.
 *
 * Chosen instead: cascading cancel is implemented generically over whatever `parentId` a job
 * happens to have (`cancel()` below walks `by_parent` regardless of how `parentId` got set), and
 * `currentJobId()` stays a stub returning `undefined`. Known limitation: a child scheduled from
 * *inside* a driver-run job today gets `parentId: undefined` (not chained) — cascading cancel
 * only reaches jobs whose `parentId` was set explicitly. The test suite (`test/reliability.test.ts`)
 * exercises the cascade via the test-only `_system:insertJob` escape hatch, which sets `parentId`
 * directly. Revisit if/when a later slice needs real parent/child chaining from driver-run jobs.
 */
export type JobState = "pending" | "inProgress" | "success" | "failed" | "canceled";
export type SignalKind = "enqueue" | "complete" | "cancel";

export interface EnqueueOpts {
  runAfter?: number;
  runAt?: number;
  retry?: { maxFailures: number };
  name?: string;
  onComplete?: string;
  context?: JSONValue;
  idempotencyKey?: string;
}

export interface SchedulerContext {
  runAfter(delayMs: number, fnRef: FnRef, args: JSONValue): Promise<string>;
  runAt(ts: number | Date, fnRef: FnRef, args: JSONValue): Promise<string>;
  cancel(id: string): Promise<void>;
  /** Internal: the general enqueue path (workflow-style callers pass `opts` directly). */
  enqueue(fnRef: FnRef, args: JSONValue, opts?: EnqueueOpts): Promise<string>;
}

/** Signal segments bucket wall-clock ms into 100ms windows so the Task 3 driver can wake precisely on `by_segment` without scanning every job. */
function segmentOf(ms: number): number {
  return Math.floor(ms / 100);
}

/**
 * `kind` (mutation vs action) isn't derivable from a bare `fnPath` string without a function
 * registry lookup; every job is a mutation this slice (actions are a later slice — see
 * CLAUDE.md build order #5). Task 5/registry wiring can replace this with a real lookup.
 */
function kindOf(_fnPath: string): "mutation" | "action" {
  return "mutation";
}

/** App-version stamping (for rolling-deploy replay safety) is wired in a later slice. */
function currentAppVersion(): string | undefined {
  return undefined;
}

/**
 * The job that scheduled the CURRENT call, if any. Still unset (returns `undefined` always) —
 * see the Task 4 design note below the module doc comment for why threading a real ambient
 * `currentJobId` through the driver/executor was deliberately deferred rather than done here.
 * Every `ctx.scheduler.*` call is therefore a top-level job (`parentId: undefined`) for now;
 * `cancel`'s cascading walk below still works for any job whose `parentId` IS set some other way
 * (currently only the test-only `_system:insertJob` escape hatch), and the born-canceled check in
 * `enqueueInternal` is wired and ready for whenever a future slice sets this ambient for real.
 */
function currentJobId(): string | undefined {
  return undefined;
}

/** Drop keys whose value is `undefined` — the wire codec (`convexToJson`) rejects `undefined`; omit rather than null it out. */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/**
 * Builds `ctx.scheduler`. Requires `contextWrite: true` on the component definition (see
 * `defineScheduler` in `./index.ts`) — without it, `cctx.db` is a read-only `GuestDatabaseReader`
 * and every write below throws `ForbiddenOperationError`. With it, and ONLY during a mutation
 * call, `cctx.db` is a `GuestDatabaseWriter` scoped to the calling mutation's own transaction —
 * so `runAfter`/`cancel` are transactional: they commit (or roll back) with the rest of the
 * calling mutation, and the resulting write fans out to reactive subscriptions like any other
 * write once it commits.
 */
export function schedulerContext(cctx: ComponentContext): SchedulerContext {
  const db = cctx.db as GuestDatabaseWriter;
  const now = (): number => cctx.now;

  async function enqueueInternal(fnRef: FnRef, args: JSONValue, opts: EnqueueOpts): Promise<string> {
    const fnPath = getFunctionPath(fnRef);
    const parentId = currentJobId();
    // Born-canceled: if the ambient parent job is already `canceled`, its children should never
    // get a chance to run either — see the Task 4 design note above `JobState` for why
    // `currentJobId()` is currently always `undefined` (making this branch unreachable today, but
    // wired and correct for whenever a future slice sets the ambient for real).
    let parentCanceled = false;
    if (parentId !== undefined) {
      const parent = await db.get(parentId);
      parentCanceled = parent !== null && parent.state === "canceled";
    }
    const bornState: JobState = parentCanceled ? "canceled" : "pending";
    const jobId = await db.insert(
      "jobs",
      compact({
        fnPath,
        kind: kindOf(fnPath),
        state: bornState,
        nextTs: opts.runAt ?? now(),
        attempts: 0,
        maxFailures: opts.retry?.maxFailures ?? 4,
        leaseHolder: undefined,
        leaseExpiresAt: undefined,
        idempotencyKey: opts.idempotencyKey,
        appVersion: currentAppVersion(),
        name: opts.name,
        hasArgs: true,
        onComplete: opts.onComplete,
        parentId,
        completedTs: parentCanceled ? now() : undefined,
      }),
    );
    await db.insert("job_args", compact({ jobId, args, context: opts.context }));
    // An append-only wake signal so the Task 3 driver's loop wakes precisely on this job's
    // segment instead of polling `jobs` blindly. Appended even when born-canceled: harmless (the
    // driver's `_peekDue` filters on `state:"pending"`, so a born-canceled job is never picked
    // up), and keeps this signal's meaning simple ("a jobs row was written") rather than
    // conditional.
    await db.insert("signals", { segment: segmentOf(now()), kind: "enqueue" as SignalKind, jobId });
    return jobId;
  }

  return {
    async runAfter(delayMs, fnRef, args) {
      return enqueueInternal(fnRef, args, { runAt: now() + Math.max(0, delayMs) });
    },
    async runAt(ts, fnRef, args) {
      return enqueueInternal(fnRef, args, { runAt: ts instanceof Date ? ts.getTime() : ts });
    },
    async cancel(id) {
      const job = await db.get(id);
      if (job !== null && job.state === "pending") {
        await db.replace(id, { ...job, state: "canceled" as JobState, completedTs: now() });
        await db.insert("signals", { segment: segmentOf(now()), kind: "cancel" as SignalKind, jobId: id });
      }
      // Cascading cancel: walk `id`'s descendants via the `by_parent` index and cancel any that
      // are still `pending` — regardless of whether `id` itself was cancelable above (it may
      // already be `inProgress`/terminal; canceling in-flight children of an already-finished or
      // still-running job is still correct — Task 4 doesn't preempt an in-flight job, but its
      // not-yet-dispatched children shouldn't run just because their ancestor already moved on).
      // Iterative BFS (a queue, not recursion) so a deep chain can't blow the stack; `seen` guards
      // against revisiting a node (defensive against a cyclic `parentId`, which shouldn't exist,
      // but costs nothing to guard).
      const queue: string[] = [id];
      const seen = new Set<string>([id]);
      while (queue.length > 0) {
        const parentId = queue.shift() as string;
        const children = await db.query("jobs", "by_parent").eq("parentId", parentId).collect();
        for (const child of children) {
          const childId = child._id as string;
          if (seen.has(childId)) continue;
          seen.add(childId);
          if (child.state === "pending") {
            await db.replace(childId, { ...child, state: "canceled" as JobState, completedTs: now() });
            await db.insert("signals", { segment: segmentOf(now()), kind: "cancel" as SignalKind, jobId: childId });
          }
          queue.push(childId); // walk deeper regardless of this child's own state
        }
      }
    },
    async enqueue(fnRef, args, opts) {
      return enqueueInternal(fnRef, args, opts ?? {});
    },
  };
}
