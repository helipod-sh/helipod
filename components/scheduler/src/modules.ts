import { query, mutation } from "@stackbase/executor";
import type { QueryCtx, MutationCtx } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { JobState } from "./facade";
import { enqueueInternal, fireOnComplete, type EnqueueTables } from "./facade";
import { computeBackoff } from "./backoff";
import { computeNextRun, computePrevRun, enqueueCadenceJob, type CronSpec, type CatchUpPolicy } from "./crons";

/**
 * Internal modules for `@stackbase/scheduler` — registered on `defineScheduler()`'s `modules` map
 * (so they're reachable as `scheduler:_peekDue` / `scheduler:_claim` / `scheduler:_complete`),
 * consumed ONLY by the Task 3 driver loop (`./driver.ts`) via `DriverContext.runFunction`, which
 * always calls privileged (`runtime-embedded/src/runtime.ts`'s `driverCtx.runFunction` sets
 * `privileged: true`). Privileged calls bypass namespace prefixing entirely (`kernel.ts`'s
 * `requireTable`), so — unlike `facade.ts`, which runs namespaced and uses bare table names
 * (`"jobs"`, `"job_args"`) — these modules must use the fully-qualified names
 * (`"scheduler/jobs"`, `"scheduler/job_args"`).
 *
 * `_peekDue`/`_claim`/`_complete` are internal by convention (the `_` prefix + being paired only
 * with the driver), not by enforced access control — see Task 3's research notes. That's an
 * accepted gap for this slice (nothing else in the codebase enforces "driver-only" beyond
 * `_system:*`/`_admin:*`'s separate privileged registries).
 */

/** Cap on how many due jobs a single `_peekDue` batch returns, so one loop iteration can't run unbounded. */
export const BATCH_CAP = 64;

/**
 * Hard ceiling on how many missed occurrences `_cronTick`'s `catchUp:"fireAll"` path will
 * materialize (and fire a work job for) in a single tick — see `_cronTick`'s doc comment. Without
 * this, a `"fireAll"` cron down for a long time on a fast interval could try to enqueue an
 * unbounded number of work jobs synchronously inside one mutation. Occurrences beyond the cap are
 * discarded (logged), not deferred to a later tick — the cron's cadence always re-anchors past
 * the ENTIRE true backlog on the SAME tick, regardless of how much of it actually got fired.
 */
export const CATCHUP_CAP = 1000;

/** How long a claim's lease is valid before it could be reclaimed by the sweep below. */
export const LEASE_MS = 30_000;

/**
 * The driver's ONLY periodic timer: how often `scheduler:_reclaim` runs to sweep `inProgress`
 * jobs whose lease has expired (an infra kill mid-run — the process that claimed the job died
 * before completing it). Normal dispatch stays fully reactive/event-driven; this is a backstop.
 */
export const SWEEP_MS = 30_000;

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
 * - `result.kind === "success"` → terminal `state:"success"`, `completedTs`, lease cleared.
 * - `result.kind === "failed"` → `attempts += 1`; if `attempts >= maxFailures`, terminal
 *   `state:"failed"` (dead-letter) + `completedTs` + `lastError`, same as success but with the
 *   error recorded. Otherwise, back to `state:"pending"` with `nextTs: now() +
 *   computeBackoff(attempts, ctx.random)` (exponential backoff, jittered via the mutation's own
 *   seeded PRNG — see `./backoff.ts`), lease cleared, `lastError` recorded — the driver's reactive
 *   `onCommit` wake picks up the `state` transition and re-arms its timer for the retry.
 *
 * No-ops (returns `null`) if the job vanished or isn't `inProgress` — defensive against a stray
 * double-complete; `_claim`'s guard is what actually prevents double-dispatch.
 */
export const _complete = mutation(async (ctx: MutationCtx, args: { jobId: string; result: JobResult }): Promise<null> => {
  const job = await ctx.db.get(args.jobId);
  if (job === null || job.state !== "inProgress") return null;
  const now = ctx.now();
  const nowFn = (): number => now;

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
    // Task 6 — workflow-ready onComplete/context round-trip: see `fireOnComplete`'s doc comment
    // in `./facade.ts`. A no-op when `job.onComplete` is unset.
    await fireOnComplete(ctx.db, nowFn, CRON_TABLES, args.jobId, job.onComplete as string | undefined, {
      kind: "success",
      value: args.result.value,
    });
    return null;
  }

  // result.kind === "failed" — retry with backoff, or dead-letter at maxFailures.
  // TODO(action-slice): actions now execute (CLAUDE.md build-order #5 — `driver.ts` no longer
  // special-cases `kind:"action"`, it dispatches through this same path a mutation uses), so this
  // gap is live, not hypothetical: a "failed" result from a CLEANLY-failed action (its own code
  // threw/rejected, as opposed to an infra kill — that's `_reclaim`'s job below) still blind-retries
  // through this same backoff path. An action's side effects aren't transactional like a
  // mutation's, so retrying one that already ran partway could re-run those side effects — this
  // branch's blanket "retry up to maxFailures" is only actually safe for `kind:"mutation"`.
  // Revisit this branch (and `_reclaim`'s, which has the same gap) — not done as part of the
  // guard-removal task.
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
    // Task 6 — dead-lettered (terminal) failure fires onComplete too, same as success; the
    // back-to-"pending" retry branch below does NOT (the job isn't actually done yet).
    await fireOnComplete(ctx.db, nowFn, CRON_TABLES, args.jobId, job.onComplete as string | undefined, {
      kind: "failed",
      error: lastError,
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
  return null;
});

/** Fully-qualified table names — see this file's module doc comment for why (`_cronTick` runs privileged, dispatched by the driver like any other due job). */
const CRON_TABLES: EnqueueTables = { jobs: "scheduler/jobs", jobArgs: "scheduler/job_args" };

/**
 * `scheduler:_enqueue` / `scheduler:_cancel` — internal (`_`-prefixed, so not client-callable)
 * MUTATIONS that back the action-mode `ctx.scheduler` facade (`schedulerActionContext` in
 * `./facade.ts`): an action has no `db`, so it can't write a `jobs` row itself — instead it calls
 * `ctx.runMutation("scheduler:_enqueue"/"_cancel", ...)`, a fresh top-level mutation the trusted
 * `invoke` seam resolves (see `ExecutorDeps.invoke`'s doc comment in `packages/executor/src/
 * executor.ts` — it resolves ANY registered path, `_`-prefixed included, unlike the public
 * `runtime.run`/`runAction`, which block `_`).
 *
 * Both run namespaced (NOT privileged) — `namespaceForPath("scheduler:_enqueue", ...)` resolves to
 * `"scheduler"`, the same namespace `schedulerContext`'s facade runs in — so `ctx.scheduler` here
 * is the ordinary in-txn facade from `./facade.ts`, writing through the SAME bare table names
 * (`FACADE_TABLES`) as a normal mutation's `ctx.scheduler.runAfter(...)` call. `ctx: any` because
 * `ctx.scheduler` isn't part of the exported `MutationCtx` shape (it's a dynamic per-component
 * facade attached at run time — see `InlineUdfExecutor.run`'s `guestCtx` loop).
 */
export const _enqueue = mutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (ctx: any, a: { fnPath: string; args: JSONValue; runAtMs: number }): Promise<string> =>
    ctx.scheduler.runAt(a.runAtMs, a.fnPath, a.args),
);

export const _cancel = mutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (ctx: any, a: { id: string }): Promise<null> => {
    await ctx.scheduler.cancel(a.id);
    return null;
  },
);

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
 *  2. Self-terminate check (duplicate-cadence-chain fix, belt-and-braces half): if `args.jobId`
 *     is present and doesn't match `cron.cadenceJobId`, this invocation is a STALE duplicate
 *     chain (one that slipped past `reconcileCrons`'s `hasLiveCadence` check some other way —
 *     see that function's doc comment in `./crons.ts`) — return immediately without firing
 *     anything or rescheduling, so at most one chain survives past its own next tick.
 *  3. `anchor = lastScheduledTs` — CLOCK-ANCHORED, never `now()`: every occurrence this tick
 *     computes chains off the cron's own last-fired timestamp, not off whenever this mutation
 *     happens to run. A late dispatch (a busy driver, a slow prior tick) never shifts the phase
 *     of later occurrences.
 *  4. **Bounded catch-up** (unbounded-loop fix): unlike the old implementation, this NEVER steps
 *     one occurrence at a time through however much backlog has accumulated — a fast interval
 *     cron down for months could mean hundreds of millions of occurrences, and computing (let
 *     alone materializing) that many synchronously inside one mutation would block the
 *     single-writer transactor for the duration, even for `"skip"` whose entire point is to
 *     discard the backlog. Instead:
 *       - **Interval specs**: the occurrence count `n` since `anchor` is computed by O(1)
 *         arithmetic (`Math.floor((now-anchor)/period)`), never a loop.
 *       - **Cron-expression specs**: whether zero/one/many occurrences are due is determined by
 *         at most two O(1) `cron-parser` calls (`computeNextRun` from `anchor`, then again from
 *         that result) — no stepping through the backlog to count it.
 *       - `"skip"` and `"fireOnce"` NEVER materialize a backlog array at all, for either spec
 *         kind — `"fireOnce"`'s single catch-up fire and every kind's `next` reschedule point are
 *         each an O(1) computation (`computePrevRun`/arithmetic for the most recent missed
 *         occurrence, `computeNextRun`/arithmetic for the next future one).
 *       - `"fireAll"` is the only policy that genuinely needs a list of occurrences to fire, and
 *         its materialization loop is hard-capped at `CATCHUP_CAP` — occurrences beyond the cap
 *         are discarded (logged), not deferred to a later tick.
 *     In every case, `lastScheduledTs` (see step 6) re-anchors to the schedule's TRUE last
 *     occurrence `<= now`, computed in O(1) regardless of catchUp policy — so even `"skip"` or a
 *     capped `"fireAll"` never drifts the cron's future phase, only the discarded/skipped
 *     occurrences themselves are lost.
 *  5. Each fired occurrence gets its OWN work job via `enqueueInternal`, keyed
 *     `idempotencyKey: "${cronName}:${fireTs}"` — insert-or-noop, so two cadence fires that ever
 *     computed the same occurrence (shouldn't happen in normal operation, but is the deterministic
 *     safety net if it did) collapse into one work job rather than double-running it.
 *  6. The cadence reschedules ITSELF at `next` (the first occurrence strictly after `now`) via
 *     `enqueueCadenceJob` (which embeds the new job's own id into its args — see that function's
 *     doc comment in `./crons.ts` — powering step 2's self-terminate check on ITS next tick).
 */
export const _cronTick = mutation(async (ctx: MutationCtx, args: { cronName: string; jobId?: string }): Promise<null> => {
  const rows = await ctx.db.query("scheduler/crons", "by_name").eq("name", args.cronName).take(1).collect();
  const cron = rows[0];
  if (cron === undefined) return null; // deregistered since this cadence job was scheduled — stop, don't reschedule

  // Belt-and-braces convergence: `args.jobId` is absent only for cadence jobs enqueued before
  // this field existed (pre-fix rows mid-upgrade) — those fall back to trusting themselves,
  // matching pre-fix behavior exactly. Otherwise, a mismatch means this is a stale duplicate
  // chain; die quietly without touching the cron row or firing anything.
  if (args.jobId !== undefined && cron.cadenceJobId !== undefined && cron.cadenceJobId !== args.jobId) {
    return null;
  }

  const now = ctx.now();
  const spec = JSON.parse(cron.spec as string) as CronSpec;
  const tz = cron.tz as string;
  const catchUp = cron.catchUp as CatchUpPolicy;
  const anchor = (cron.lastScheduledTs as number | undefined) ?? now;
  const nowFn = (): number => ctx.now();

  // See step 4 above — every branch below is O(1) arithmetic / a small constant number of
  // `cron-parser` calls, except `"fireAll"`'s materialization loop, explicitly capped at
  // `CATCHUP_CAP`. Nothing here scales with how large the actual backlog is.
  let toFire: number[];
  let next: number; // first occurrence strictly after `now` — where the cadence reschedules
  let newLastScheduledTs: number; // re-anchor point for the NEXT tick

  if (spec.kind === "interval") {
    const period = spec.ms;
    const elapsed = now - anchor;
    // How many occurrences have elapsed (<= now) since `anchor` — computed directly, never by
    // stepping, so this is cheap even when `n` is in the hundreds of millions. (`anchor + i*period
    // <= now` iff `i <= elapsed/period`, so the count of such `i >= 1` is `floor(elapsed/period)`.)
    const n = elapsed >= 0 ? Math.floor(elapsed / period) : 0;

    if (n === 0) {
      // Nothing due yet (defensive: the driver only dispatches this job once its own `nextTs` is
      // <= now, so this shouldn't normally happen — but a clock oddity shouldn't crash it).
      toFire = [];
      next = anchor + period;
      newLastScheduledTs = anchor;
    } else if (n === 1) {
      // On-time (or first-ever) single fire — always happens, independent of `catchUp`.
      const only = anchor + period;
      toFire = [only];
      next = only + period;
      newLastScheduledTs = only;
    } else {
      // A backlog of `n` missed occurrences, `n` known exactly via O(1) arithmetic.
      const lastOccurrence = anchor + n * period; // the TRUE last occurrence <= now
      next = lastOccurrence + period; // strictly after `now`, by construction of `n`
      newLastScheduledTs = lastOccurrence; // re-anchor to the real schedule regardless of `catchUp`

      if (catchUp === "fireAll") {
        // The only policy that genuinely needs a materialized list. Hard-capped at
        // `CATCHUP_CAP` so even a multi-hundred-million-occurrence backlog does bounded work —
        // fires the OLDEST `min(n, CATCHUP_CAP)` occurrences; anything beyond the cap is
        // discarded for good (`newLastScheduledTs` above already re-anchors past the ENTIRE true
        // backlog, not just the fired subset).
        const fireCount = Math.min(n, CATCHUP_CAP);
        toFire = [];
        for (let i = 0; i < fireCount; i++) toFire.push(anchor + (i + 1) * period);
        if (n > CATCHUP_CAP) {
          console.warn(
            `[scheduler] cron "${cron.name as string}": fireAll backlog of ${n} occurrences exceeded CATCHUP_CAP (${CATCHUP_CAP}) — fired the oldest ${CATCHUP_CAP}, discarded the rest.`,
          );
        }
      } else if (catchUp === "fireOnce") {
        toFire = [lastOccurrence];
      } else {
        toFire = []; // "skip" (default) — jump straight past the backlog, fire nothing for it
      }
    }
  } else {
    // spec.kind === "cron". `computeNextRun`/`computePrevRun` are each a single O(1) cron-parser
    // call (field arithmetic, not calendar stepping), so every branch below stays bounded
    // regardless of backlog length EXCEPT `"fireAll"`'s materialization loop (capped below).
    const firstAfterAnchor = computeNextRun(spec, tz, anchor);

    if (firstAfterAnchor > now) {
      // Nothing due yet.
      toFire = [];
      next = firstAfterAnchor;
      newLastScheduledTs = anchor;
    } else {
      const secondAfterAnchor = computeNextRun(spec, tz, firstAfterAnchor);
      if (secondAfterAnchor > now) {
        // Exactly one occurrence due — on-time (or first-ever) single fire.
        toFire = [firstAfterAnchor];
        next = secondAfterAnchor;
        newLastScheduledTs = firstAfterAnchor;
      } else {
        // A backlog of 2+ occurrences. Unlike interval specs, the EXACT count isn't cheap to
        // know for an arbitrary cron expression without stepping through it — so `"skip"` and
        // `"fireOnce"` never do that: both get everything they need from two more O(1) calls
        // (the real next occurrence, and the single most recent missed one). Only `"fireAll"`
        // steps at all, and that step is hard-capped at `CATCHUP_CAP` iterations.
        next = computeNextRun(spec, tz, now); // first real occurrence strictly after `now`
        const lastOccurrence = computePrevRun(spec, tz, now); // most recent missed occurrence
        newLastScheduledTs = lastOccurrence; // re-anchor to the real schedule regardless of `catchUp`

        if (catchUp === "fireAll") {
          toFire = [];
          let cursor = firstAfterAnchor;
          let truncated = false;
          while (cursor <= now) {
            if (toFire.length >= CATCHUP_CAP) {
              truncated = true;
              break;
            }
            toFire.push(cursor);
            cursor = computeNextRun(spec, tz, cursor);
          }
          if (truncated) {
            console.warn(
              `[scheduler] cron "${cron.name as string}": fireAll backlog exceeded CATCHUP_CAP (${CATCHUP_CAP}) — fired the oldest ${CATCHUP_CAP}, discarded the rest.`,
            );
          }
        } else if (catchUp === "fireOnce") {
          toFire = [lastOccurrence];
        } else {
          // "skip" (default) — the exact missed count isn't tracked for cron-expression specs
          // (see this branch's comment above); a log marker stands in for it.
          toFire = [];
          console.warn(
            `[scheduler] cron "${cron.name as string}": skipped a downtime backlog (catchUp:"skip") — exact occurrence count not tracked for cron-expression specs.`,
          );
        }
      }
    }
  }

  for (const fireTs of toFire) {
    await enqueueInternal(ctx.db, nowFn, CRON_TABLES, cron.workFnPath as string, cron.workArgs as JSONValue, {
      runAt: fireTs,
      idempotencyKey: `${cron.name as string}:${fireTs}`,
      name: cron.name as string,
    });
  }

  const cadenceJobId = await enqueueCadenceJob(ctx.db, nowFn, CRON_TABLES, cron.name as string, next);

  await ctx.db.replace(
    cron._id as string,
    compact({
      ...cron,
      lastScheduledTs: newLastScheduledTs,
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
 *    no backoff; an infra kill isn't the job's own fault).
 *  - `kind:"action"` → NOT safe to blindly retry (actions have arbitrary external side effects,
 *    so at-most-once is the only safe default without idempotency-key support): `attempts += 1`,
 *    terminal `state:"failed"` (dead-letter) with `lastError`.
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
    }
    reclaimed++;
  }
  return { reclaimed };
});
