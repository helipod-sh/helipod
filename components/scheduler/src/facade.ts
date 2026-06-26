import type { ComponentContext, ActionApi } from "@stackbase/executor";
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
export function getFunctionPath(ref: FnRef): string {
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

export interface EnqueueOpts {
  /** Relative delay in ms from the enqueueing call's `now()`. `runAt` wins when both are set. */
  runAfter?: number;
  /** Absolute due time (epoch ms). Takes precedence over `runAfter`. */
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
export function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/**
 * The two `jobs`/`job_args` table names `enqueueInternal` writes to — bare (`"jobs"`) when
 * called from this file's own namespaced `ctx.scheduler` facade, or fully qualified
 * (`"scheduler/jobs"`) when called from a privileged context (`_cronTick` in `./modules.ts`, and
 * the boot-time cron reconciler in `./crons.ts`) that bypasses namespace prefixing entirely —
 * see `./modules.ts`'s module doc comment for why those callers must use fully-qualified names.
 */
export interface EnqueueTables {
  jobs: string;
  jobArgs: string;
}

/**
 * The shared enqueue path: inserts a `pending` `jobs` row (+ `job_args`), honoring the
 * born-canceled check and, since Task 5, an idempotent insert-or-noop on `opts.idempotencyKey`
 * (looked up via `by_idempotency`) — if a job with that key already exists, its id is returned
 * unchanged and nothing new is inserted. This dedup is what makes the cron cadence's occurrence
 * key (`${cronName}:${fireTs}`, `_cronTick` in `./modules.ts`) safe to call more than once for
 * the same occurrence (e.g. a reclaim-driven re-run of a cadence job).
 *
 * Factored out of `schedulerContext` (which calls it with bare table names, scoped to the calling
 * mutation's own transaction via `db`) so `_cronTick` and the boot-time cron reconciler — both of
 * which write with fully-qualified table names outside a normal namespaced call — can reuse the
 * exact same logic rather than a parallel reimplementation drifting out of sync.
 */
export async function enqueueInternal(
  db: GuestDatabaseWriter,
  now: () => number,
  tables: EnqueueTables,
  fnRef: FnRef,
  args: JSONValue,
  opts: EnqueueOpts,
  /**
   * Resolves the target's real kind for the job's `kind` column. Defaults to always-"mutation"
   * — correct for every caller EXCEPT `schedulerContext`'s facade methods below, which pass a
   * closure over `cctx.functionKind` (the only caller whose target might actually be an action;
   * `_cronTick`'s cadence/work jobs and `fireOnComplete`'s callback are always mutations).
   */
  kindOf: (fnPath: string) => "mutation" | "action" = () => "mutation",
): Promise<string> {
  const fnPath = getFunctionPath(fnRef);

  if (opts.idempotencyKey !== undefined) {
    const existing = await db.query(tables.jobs, "by_idempotency").eq("idempotencyKey", opts.idempotencyKey).take(1).collect();
    const found = existing[0];
    if (found) return found._id as string;
  }

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
  const kind = kindOf(fnPath);
  // Due time: absolute `runAt` wins; else relative `runAfter` (clamped to non-negative, matching
  // the facade's own `runAfter` method); else immediately due.
  const nextTs = opts.runAt ?? (opts.runAfter !== undefined ? now() + Math.max(0, opts.runAfter) : now());
  const jobId = await db.insert(
    tables.jobs,
    compact({
      fnPath,
      kind,
      state: bornState,
      nextTs,
      attempts: 0,
      // Retry budget. Mutations are transactional (a failed one committed nothing), so retrying is
      // always safe: default 4. Actions have arbitrary external side effects, so a CLEANLY-failed
      // action (its own code threw after possibly running partway) must NOT be blindly re-run:
      // default 1, i.e. dead-letter on the first failure (`_complete`'s `attempts >= maxFailures`
      // check). An explicit `opts.retry` is the author's opt-in that the target is safe to re-run
      // (e.g. `@stackbase/workflow` threading a step's declared `maxAttempts` through here) and is
      // honored as-is for both kinds.
      maxFailures: opts.retry?.maxFailures ?? (kind === "action" ? 1 : 4),
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
  await db.insert(tables.jobArgs, compact({ jobId, args, context: opts.context }));
  return jobId;
}

/** Bare (namespaced-by-the-executor) table names — what `schedulerContext`'s facade writes through. */
const FACADE_TABLES: EnqueueTables = { jobs: "jobs", jobArgs: "job_args" };

/**
 * The terminal outcome an `onComplete` callback is invoked with — a strict superset of
 * `./modules.ts`'s `JobResult` (which only ever carries `success`/`failed`, the two outcomes
 * `_complete` itself produces) plus `canceled`, produced by `cancel()` below. Defined here (not
 * `./modules.ts`) so `./modules.ts` — which already imports from this file — can reuse it without
 * a circular import back the other way.
 */
export type OnCompleteResult = { kind: "success"; value: unknown } | { kind: "failed"; error: string } | { kind: "canceled" };

/**
 * Task 6 — the workflow-ready `onComplete`/`context` round-trip: if `job.onComplete` (a mutation
 * path) is set, enqueue it with `{ jobId, context, result }`, where `context` is `job_args`'s
 * `context` for THIS job read back verbatim (opaque to the scheduler — never interpreted, just
 * round-tripped) and `result` is the terminal outcome. Enqueued via `runAt: now()` (the `runAfter:
 * 0` semantics) so it's immediately due — the reactive wake picks it up on the very next
 * commit-driven iteration, no extra latency beyond one dispatch pass.
 *
 * A no-op when `onComplete` is `undefined` (the common case — most jobs don't register a
 * completion callback). Called from exactly two terminal transitions, never a retry:
 *  - `./modules.ts`'s `_complete`, on `state:"success"` and on dead-lettered `state:"failed"`
 *    (NOT on the back-to-`"pending"` retry branch — the job isn't actually done yet).
 *  - `cancel()` below, for both the directly-canceled job and any cascaded-canceled descendant.
 */
export async function fireOnComplete(
  db: GuestDatabaseWriter,
  now: () => number,
  tables: EnqueueTables,
  jobId: string,
  onComplete: string | undefined,
  result: OnCompleteResult,
): Promise<void> {
  if (onComplete === undefined) return;
  const argRows = await db.query(tables.jobArgs, "by_job").eq("jobId", jobId).take(1).collect();
  const context = argRows[0]?.context as JSONValue | undefined;
  await enqueueInternal(db, now, tables, onComplete, compact({ jobId, context, result }) as unknown as JSONValue, { runAt: now() });
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

  // Resolves the target's REAL registered kind via the runtime-supplied `cctx.functionKind` (see
  // its doc comment in `packages/executor/src/executor.ts`) — no longer a stub. Actions are the
  // only non-transactional kind → the only one `_reclaim` (`./modules.ts`) must not blind-retry.
  // A query is never a valid schedule target; treat anything not "action" as "mutation"
  // (conservative: retryable). Unknown path (resolver absent, or the runtime didn't recognize the
  // path) also defaults "mutation" — matches prior behavior; an unknown fn fails at dispatch
  // regardless of what `kind` its job row was born with.
  const kindOf = (fnPath: string): "mutation" | "action" => (cctx.functionKind?.(fnPath) === "action" ? "action" : "mutation");

  return {
    async runAfter(delayMs, fnRef, args) {
      return enqueueInternal(db, now, FACADE_TABLES, fnRef, args, { runAt: now() + Math.max(0, delayMs) }, kindOf);
    },
    async runAt(ts, fnRef, args) {
      return enqueueInternal(db, now, FACADE_TABLES, fnRef, args, { runAt: ts instanceof Date ? ts.getTime() : ts }, kindOf);
    },
    async cancel(id) {
      const job = await db.get(id);
      if (job !== null && job.state === "pending") {
        await db.replace(id, { ...job, state: "canceled" as JobState, completedTs: now() });
        await fireOnComplete(db, now, FACADE_TABLES, id, job.onComplete as string | undefined, { kind: "canceled" });
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
            await fireOnComplete(db, now, FACADE_TABLES, childId, child.onComplete as string | undefined, { kind: "canceled" });
          }
          queue.push(childId); // walk deeper regardless of this child's own state
        }
      }
    },
    async enqueue(fnRef, args, opts) {
      return enqueueInternal(db, now, FACADE_TABLES, fnRef, args, opts ?? {}, kindOf);
    },
  };
}

/**
 * The action-mode counterpart to `SchedulerContext` — same `runAfter`/`runAt`/`cancel` method
 * signatures (so a function body scheduling work is portable between a mutation and an action),
 * minus `enqueue` (the general opts-carrying path stays a mutation-only internal primitive; no
 * action caller needs it yet). Deliberately NOT structurally assignable to `SchedulerContext` as a
 * type (no `enqueue`) even though the three shared methods match exactly.
 */
export interface SchedulerActionContext {
  runAfter(delayMs: number, fnRef: FnRef, args: JSONValue): Promise<string>;
  runAt(ts: number | Date, fnRef: FnRef, args: JSONValue): Promise<string>;
  cancel(id: string): Promise<void>;
}

/**
 * Builds the action-mode `ctx.scheduler` — wired as `defineScheduler()`'s `buildAction` (see
 * `./index.ts`). An action has no `db`, so `runAfter`/`runAt`/`cancel` can't write a `jobs` row
 * directly the way `schedulerContext` above does; instead each delegates to `api.runMutation` of
 * the internal `scheduler:_enqueue`/`scheduler:_cancel` mutations (`./modules.ts`), which run the
 * SAME `enqueueInternal`/`cancel` logic inside their own fresh top-level transaction.
 *
 * `Date.now()` below (converting `runAfter`'s relative `delayMs` to an absolute `runAtMs`) is fine
 * here even though queries/mutations must stay deterministic: an action is non-deterministic by
 * design (see `ActionCtx`'s doc comment in `@stackbase/executor`), and the scheduler never
 * recomputes anything from this timestamp — `scheduler:_enqueue` just stores it as `nextTs`.
 */
export function schedulerActionContext(api: ActionApi): SchedulerActionContext {
  return {
    async runAfter(delayMs, fnRef, args) {
      return api.runMutation<string>("scheduler:_enqueue", { fnPath: getFunctionPath(fnRef), args, runAtMs: Date.now() + delayMs });
    },
    async runAt(ts, fnRef, args) {
      return api.runMutation<string>("scheduler:_enqueue", {
        fnPath: getFunctionPath(fnRef),
        args,
        runAtMs: ts instanceof Date ? ts.getTime() : ts,
      });
    },
    async cancel(id) {
      await api.runMutation("scheduler:_cancel", { id });
    },
  };
}
