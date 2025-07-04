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
 * The job that scheduled the CURRENT call, if any. Unset this slice (no ambient is set outside
 * the Task 3 driver loop), so every `ctx.scheduler.*` call made from a request-time mutation is a
 * top-level job (`parentId: null`). The Task 3 driver sets this ambient while running a job so
 * jobs it schedules chain via `parentId` (used by Task 4's cascading cancel).
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
    const jobId = await db.insert(
      "jobs",
      compact({
        fnPath,
        kind: kindOf(fnPath),
        state: "pending" as JobState,
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
        parentId: currentJobId(),
        completedTs: undefined,
      }),
    );
    await db.insert("job_args", compact({ jobId, args, context: opts.context }));
    // An append-only wake signal so the Task 3 driver's loop wakes precisely on this job's
    // segment instead of polling `jobs` blindly.
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
      if (job === null) return; // no such job — nothing to cancel
      if (job.state !== "pending") return; // only a pending job can be canceled (Task 4: cascading cancel of children)
      await db.replace(id, { ...job, state: "canceled" as JobState, completedTs: now() });
      await db.insert("signals", { segment: segmentOf(now()), kind: "cancel" as SignalKind, jobId: id });
    },
    async enqueue(fnRef, args, opts) {
      return enqueueInternal(fnRef, args, opts ?? {});
    },
  };
}
