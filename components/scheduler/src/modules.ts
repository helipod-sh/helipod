import { query, mutation } from "@stackbase/executor";
import type { QueryCtx, MutationCtx } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { JobState, SignalKind } from "./facade";
import { enqueueInternal, type EnqueueTables } from "./facade";
import { computeBackoff } from "./backoff";
import { computeNextRun, type CronSpec, type CatchUpPolicy } from "./crons";

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

/** How long a claim's lease is valid before it could be reclaimed by the sweep below. */
export const LEASE_MS = 30_000;

/**
 * The driver's ONLY periodic timer: how often `scheduler:_reclaim` runs to sweep `inProgress`
 * jobs whose lease has expired (an infra kill mid-run — the process that claimed the job died
 * before completing it). Normal dispatch stays fully reactive/event-driven; this is a backstop.
 */
export const SWEEP_MS = 30_000;

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
 * `scheduler:_complete` — a MUTATION: finalizes a claimed job.
 *
 * - `result.kind === "success"` → terminal `state:"success"`, `completedTs`, lease cleared, a
 *   `complete` signal carrying the outcome.
 * - `result.kind === "failed"` → `attempts += 1`; if `attempts >= maxFailures`, terminal
 *   `state:"failed"` (dead-letter) + `completedTs` + `lastError`, same as success but with the
 *   error recorded. Otherwise, back to `state:"pending"` with `nextTs: now() +
 *   computeBackoff(attempts, ctx.random)` (exponential backoff, jittered via the mutation's own
 *   seeded PRNG — see `./backoff.ts`), lease cleared, `lastError` recorded, and an `enqueue`
 *   signal appended (NOT `complete` — the job isn't done, and the driver needs the signal to
 *   re-arm its wake timer for the retry; a `complete` signal here would be misleading to anything
 *   watching `signals` for terminal outcomes).
 *
 * No-ops (returns `null`) if the job vanished or isn't `inProgress` — defensive against a stray
 * double-complete; `_claim`'s guard is what actually prevents double-dispatch.
 */
export const _complete = mutation(async (ctx: MutationCtx, args: { jobId: string; result: JobResult }): Promise<null> => {
  const job = await ctx.db.get(args.jobId);
  if (job === null || job.state !== "inProgress") return null;
  const now = ctx.now();

  if (args.result.kind === "success") {
    await ctx.db.replace(
      args.jobId,
      compact({
        ...job,
        state: "success" as JobState,
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
  }

  // result.kind === "failed" — retry with backoff, or dead-letter at maxFailures.
  // TODO(action-slice): once actions can execute (CLAUDE.md build-order #5), a "failed" result
  // from a CLEANLY-failed action (its own code threw/rejected, as opposed to an infra kill —
  // that's `_reclaim`'s job below) must NOT blind-retry through this same backoff path. An
  // action's side effects aren't transactional like a mutation's, so retrying one that already
  // ran partway could re-run those side effects — this branch's blanket "retry up to
  // maxFailures" is only safe for `kind:"mutation"` today (the only kind that actually runs —
  // see `driver.ts`'s action guard). Revisit this branch (and `_reclaim`'s, which has the same
  // gap) when actions are real.
  const attempts = (job.attempts as number) + 1;
  const maxFailures = job.maxFailures as number;
  const lastError = args.result.error;

  if (attempts >= maxFailures) {
    await ctx.db.replace(
      args.jobId,
      compact({
        ...job,
        state: "failed" as JobState,
        attempts,
        completedTs: now,
        lastError,
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
    return null;
  }

  const nextTs = now + computeBackoff(attempts, ctx.random);
  await ctx.db.replace(
    args.jobId,
    compact({
      ...job,
      state: "pending" as JobState,
      attempts,
      nextTs,
      lastError,
      leaseHolder: undefined,
      leaseExpiresAt: undefined,
    }),
  );
  // An `enqueue` signal (not `complete`) — the job is going back to `pending`, and the driver's
  // reactive wake needs a scheduler/* commit to notice the retry and re-arm its timer to `nextTs`.
  await ctx.db.insert("scheduler/signals", { segment: segmentOf(now), kind: "enqueue" as SignalKind, jobId: args.jobId });
  return null;
});

/** Fully-qualified table names — see this file's module doc comment for why (`_cronTick` runs privileged, dispatched by the driver like any other due job). */
const CRON_TABLES: EnqueueTables = { jobs: "scheduler/jobs", jobArgs: "scheduler/job_args", signals: "scheduler/signals" };

/**
 * `scheduler:_cronTick` — a MUTATION: the dual-job cron cadence. Registered as an ordinary
 * `jobs` row itself (`fnPath:"scheduler:_cronTick"`, `kind:"mutation"`) — the driver dispatches
 * it through the exact same `_peekDue`/`_claim`/`_complete` path as any other due job (see
 * `driver.ts`'s `runPass`), which is what makes it decoupled: a slow/failing WORK job (enqueued
 * below) is a completely separate `jobs` row with its own lease/retry lifecycle, so it can never
 * block or delay this cadence job's own on-time reschedule.
 *
 * Per fire:
 *  1. Read the `crons` row by `name` (via `by_name`) — a no-op if it's gone (the cron was
 *     deregistered by boot's `reconcileCrons` since this cadence job was scheduled; see
 *     `./crons.ts`).
 *  2. `anchor = lastScheduledTs` — CLOCK-ANCHORED, never `now()`: every occurrence this tick
 *     computes chains off the cron's own last-fired timestamp, not off whenever this mutation
 *     happens to run. A late dispatch (a busy driver, a slow prior tick) never shifts the phase
 *     of later occurrences — `computeNextRun` is called repeatedly from `anchor` forward until
 *     the result is past `now`, collecting every occurrence in between as `occurrences`.
 *  3. `catchUp` decides how many of a MULTI-occurrence backlog (downtime — more than one
 *     occurrence elapsed since the last tick) actually get a work job: `"skip"` fires none of
 *     them (jumps straight to the next future occurrence), `"fireOnce"` fires only the most
 *     recent, `"fireAll"` fires every one. The single-occurrence (on-time) case always fires
 *     regardless of policy — `catchUp` only matters when there's a backlog to decide about.
 *  4. Each fired occurrence gets its OWN work job via `enqueueInternal`, keyed
 *     `idempotencyKey: "${cronName}:${fireTs}"` — insert-or-noop, so two cadence fires that ever
 *     computed the same occurrence (shouldn't happen in normal operation, but is the deterministic
 *     safety net if it did) collapse into one work job rather than double-running it.
 *  5. The cadence reschedules ITSELF at `next` (the first occurrence strictly after `now`), and
 *     `lastScheduledTs` advances to the last occurrence this tick considered (fired or skipped) —
 *     so a `"skip"` catch-up still re-anchors to the real schedule instead of drifting to `now`.
 */
export const _cronTick = mutation(async (ctx: MutationCtx, args: { cronName: string }): Promise<null> => {
  const rows = await ctx.db.query("scheduler/crons", "by_name").eq("name", args.cronName).take(1).collect();
  const cron = rows[0];
  if (cron === undefined) return null; // deregistered since this cadence job was scheduled — stop, don't reschedule

  const now = ctx.now();
  const spec = JSON.parse(cron.spec as string) as CronSpec;
  const tz = cron.tz as string;
  const catchUp = cron.catchUp as CatchUpPolicy;
  const anchor = (cron.lastScheduledTs as number | undefined) ?? now;

  const occurrences: number[] = [];
  let cursor = anchor;
  let next = computeNextRun(spec, tz, cursor);
  while (next <= now) {
    occurrences.push(next);
    cursor = next;
    next = computeNextRun(spec, tz, cursor);
  }
  // `next` is now the first occurrence strictly after `now` — the cadence reschedules there.

  let toFire: number[];
  if (occurrences.length <= 1) {
    toFire = occurrences; // on-time (or first-ever) fire: always happens, independent of `catchUp`
  } else if (catchUp === "fireAll") {
    toFire = occurrences;
  } else if (catchUp === "fireOnce") {
    toFire = [occurrences[occurrences.length - 1] as number];
  } else {
    toFire = []; // "skip" (default) — jump past the backlog, fire nothing for it
  }

  const nowFn = (): number => ctx.now();
  for (const fireTs of toFire) {
    await enqueueInternal(ctx.db, nowFn, CRON_TABLES, cron.workFnPath as string, cron.workArgs as JSONValue, {
      runAt: fireTs,
      idempotencyKey: `${cron.name as string}:${fireTs}`,
      name: cron.name as string,
    });
  }

  const cadenceJobId = await enqueueInternal(ctx.db, nowFn, CRON_TABLES, "scheduler:_cronTick", { cronName: cron.name as string }, { runAt: next });

  await ctx.db.replace(
    cron._id as string,
    compact({
      ...cron,
      lastScheduledTs: occurrences.length > 0 ? (occurrences[occurrences.length - 1] as number) : anchor,
      cadenceJobId,
    }),
  );
  return null;
});

/**
 * `scheduler:_reclaim` — a MUTATION: the driver's safety-sweep backstop for infra kills. Scans
 * `inProgress` jobs whose lease has expired (`leaseExpiresAt < now` — the process that `_claim`ed
 * them died, or is at least still holding a lease well past its promised deadline) and reclaims
 * each:
 *  - `kind:"mutation"` → safe to retry (mutations are deterministic/idempotent-by-replay in this
 *    engine's model): `attempts += 1`, back to `state:"pending"` with `nextTs: now()` (immediate —
 *    no backoff; an infra kill isn't the job's own fault) and an `enqueue` signal.
 *  - `kind:"action"` → NOT safe to blindly retry (actions have arbitrary external side effects,
 *    so at-most-once is the only safe default without idempotency-key support): `attempts += 1`,
 *    terminal `state:"failed"` (dead-letter) with `lastError` + a `complete` signal.
 *
 * Uses the `by_next_ts` index (`["state","nextTs"]`) to scan `state:"inProgress"` cheaply, then a
 * post-filter on `leaseExpiresAt` (not part of that index) — `inProgress` job counts are expected
 * to be small (bounded by in-flight concurrency), so this is capped at `BATCH_CAP` per sweep
 * rather than truly unbounded, consistent with `_peekDue`.
 */
export const _reclaim = mutation(async (ctx: MutationCtx): Promise<{ reclaimed: number }> => {
  const now = ctx.now();
  const expired = await ctx.db
    .query("scheduler/jobs", "by_next_ts")
    .eq("state", "inProgress")
    .where("lt", "leaseExpiresAt", now)
    .take(BATCH_CAP)
    .collect();

  let reclaimed = 0;
  for (const job of expired) {
    const jobId = job._id as string;
    const attempts = (job.attempts as number) + 1;
    const lastError = "lease expired: driver did not complete the job before its lease deadline (infra kill)";
    if (job.kind === "mutation") {
      // Deliberate gap, ticket-worthy: unlike `_complete`'s failed-path retry (which dead-letters
      // once `attempts >= maxFailures`), this reclaim path has no such cap — a mutation that
      // reliably crashes the process it's claimed on (rather than throwing, which `_complete`
      // would catch) gets reclaimed to `pending` and re-dispatched forever, incrementing
      // `attempts` each time but never comparing it to `maxFailures` here. A true crash-loop
      // (not just a slow/flaky job) would retry indefinitely rather than dead-lettering. Bounding
      // this (e.g. dead-letter once `attempts >= maxFailures` here too) is future work, not done
      // in this task.
      await ctx.db.replace(
        jobId,
        compact({
          ...job,
          state: "pending" as JobState,
          attempts,
          nextTs: now, // immediate — the delay was the crash, not the job's own backoff
          lastError,
          leaseHolder: undefined,
          leaseExpiresAt: undefined,
        }),
      );
      await ctx.db.insert("scheduler/signals", { segment: segmentOf(now), kind: "enqueue" as SignalKind, jobId });
    } else {
      // kind:"action" — at-most-once: an expired lease means we can't tell whether the action's
      // side effects already ran, so retrying could double-run them. Dead-letter instead.
      await ctx.db.replace(
        jobId,
        compact({
          ...job,
          state: "failed" as JobState,
          attempts,
          completedTs: now,
          lastError,
          leaseHolder: undefined,
          leaseExpiresAt: undefined,
        }),
      );
      await ctx.db.insert("scheduler/signals", {
        segment: segmentOf(now),
        kind: "complete" as SignalKind,
        jobId,
        payload: { kind: "failed", error: lastError } as unknown as JSONValue,
      });
    }
    reclaimed++;
  }
  return { reclaimed };
});
