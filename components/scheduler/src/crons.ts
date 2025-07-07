/**
 * `cronJobs()` — the declarative recurring-schedule registry, Convex-parity surface. An app's
 * `crons.ts` does:
 *
 * ```ts
 * import { cronJobs } from "./_generated/server";
 * const crons = cronJobs();
 * crons.interval("cleanup", { minutes: 5 }, internal.maintenance.purge, {});
 * crons.cron("nightly", "0 3 * * *", internal.reports.build, {}, { tz: "America/New_York" });
 * crons.daily("digest", { hourUTC: 8, minuteUTC: 0 }, internal.email.digest, {});
 * export default crons;
 * ```
 *
 * `cronJobs()` itself just COLLECTS entries in-memory (`register` below) — nothing is scheduled
 * until `reconcileCrons` (this file) runs as the scheduler component's `boot` step (wired in
 * `./index.ts`), which diffs the registered entries against the `crons` table by `name` and
 * ensures each has a live cadence job. See `reconcileCrons`'s doc comment for the "how does the
 * app's crons.ts reach the component" wiring decision.
 *
 * `computeNextRun` wraps `cron-parser` (cron-expression specs, IANA `tz`) and does plain
 * arithmetic (interval specs) — the one function `_cronTick` (`./modules.ts`) calls to advance
 * the cadence, always from the last-fired anchor, never from `now()` (clock-anchored, no drift).
 */
import { parseExpression } from "cron-parser";
import type { JSONValue } from "@stackbase/values";
import type { BootContext } from "@stackbase/component";
import { getFunctionPath, enqueueInternal, type FnRef, type EnqueueTables } from "./facade";

export type CatchUpPolicy = "skip" | "fireOnce" | "fireAll";

/** The two spec shapes `computeNextRun` understands. Stored on the `crons` row JSON-serialized (`spec: v.string()`). */
export type CronSpec = { kind: "interval"; ms: number } | { kind: "cron"; expr: string };

export interface CronRegistryEntry {
  name: string;
  spec: CronSpec;
  tz: string;
  catchUp: CatchUpPolicy;
  workFnPath: string;
  workArgs: JSONValue;
}

export interface IntervalPeriod {
  seconds?: number;
  minutes?: number;
  hours?: number;
}
export interface DailyAt {
  hourUTC: number;
  minuteUTC: number;
}
export interface HourlyAt {
  minuteUTC: number;
}
export type DayOfWeek = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
export interface WeeklyAt {
  dayOfWeek: DayOfWeek;
  hourUTC: number;
  minuteUTC: number;
}
export interface MonthlyAt {
  day: number;
  hourUTC: number;
  minuteUTC: number;
}

/** `tz`/`catchUp` are additive Stackbase extensions (absent on Convex) — see the design spec §5.2. */
export interface CronOpts {
  tz?: string;
  catchUp?: CatchUpPolicy;
}
/** `.daily`/`.hourly`/`.weekly`/`.monthly` take *UTC fields by name — `tz` isn't accepted (it'd be ambiguous which field it applies to); only `catchUp` is overridable. */
export type CronUtcOpts = Pick<CronOpts, "catchUp">;

export interface CronJobs {
  interval(name: string, period: IntervalPeriod, fnRef: FnRef, args: JSONValue, opts?: CronOpts): void;
  cron(name: string, expr: string, fnRef: FnRef, args: JSONValue, opts?: CronOpts): void;
  daily(name: string, at: DailyAt, fnRef: FnRef, args: JSONValue, opts?: CronUtcOpts): void;
  hourly(name: string, at: HourlyAt, fnRef: FnRef, args: JSONValue, opts?: CronUtcOpts): void;
  weekly(name: string, at: WeeklyAt, fnRef: FnRef, args: JSONValue, opts?: CronUtcOpts): void;
  monthly(name: string, at: MonthlyAt, fnRef: FnRef, args: JSONValue, opts?: CronUtcOpts): void;
  /** Boot-reconciliation seam — not part of the public Convex-parity surface. */
  __entries(): CronRegistryEntry[];
}

const DEFAULT_CATCH_UP: CatchUpPolicy = "skip";
const DEFAULT_TZ = "UTC";

const DAY_NUMBERS: Record<DayOfWeek, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** `cronJobs()` — see this file's module doc comment for the full `crons.ts` shape. */
export function cronJobs(): CronJobs {
  const entries = new Map<string, CronRegistryEntry>();

  function register(name: string, spec: CronSpec, tz: string | undefined, catchUp: CatchUpPolicy | undefined, fnRef: FnRef, args: JSONValue): void {
    if (entries.has(name)) throw new Error(`cron "${name}" is already registered — cron identifiers must be unique`);
    entries.set(name, {
      name,
      spec,
      tz: tz ?? DEFAULT_TZ,
      catchUp: catchUp ?? DEFAULT_CATCH_UP,
      workFnPath: getFunctionPath(fnRef),
      workArgs: args,
    });
  }

  return {
    interval(name, period, fnRef, args, opts) {
      const ms = (period.seconds ?? 0) * 1000 + (period.minutes ?? 0) * 60_000 + (period.hours ?? 0) * 3_600_000;
      if (ms <= 0) throw new Error(`cron "${name}": interval must resolve to a positive duration`);
      register(name, { kind: "interval", ms }, opts?.tz, opts?.catchUp, fnRef, args);
    },
    cron(name, expr, fnRef, args, opts) {
      register(name, { kind: "cron", expr }, opts?.tz, opts?.catchUp, fnRef, args);
    },
    daily(name, at, fnRef, args, opts) {
      register(name, { kind: "cron", expr: `${at.minuteUTC} ${at.hourUTC} * * *` }, DEFAULT_TZ, opts?.catchUp, fnRef, args);
    },
    hourly(name, at, fnRef, args, opts) {
      register(name, { kind: "cron", expr: `${at.minuteUTC} * * * *` }, DEFAULT_TZ, opts?.catchUp, fnRef, args);
    },
    weekly(name, at, fnRef, args, opts) {
      register(name, { kind: "cron", expr: `${at.minuteUTC} ${at.hourUTC} * * ${DAY_NUMBERS[at.dayOfWeek]}` }, DEFAULT_TZ, opts?.catchUp, fnRef, args);
    },
    monthly(name, at, fnRef, args, opts) {
      register(name, { kind: "cron", expr: `${at.minuteUTC} ${at.hourUTC} ${at.day} * *` }, DEFAULT_TZ, opts?.catchUp, fnRef, args);
    },
    __entries: () => [...entries.values()],
  };
}

/**
 * Computes the next fire time strictly AFTER `afterTs`, per `spec`. For `{kind:"interval"}`
 * that's plain arithmetic; for `{kind:"cron"}` it's `cron-parser`'s `parseExpression(...).next()`
 * against `afterTs` as `currentDate` in the given IANA `tz` — verified to return a date strictly
 * greater than `afterTs` even when `afterTs` itself exactly matches the pattern (i.e. calling
 * this again with the returned value as the new `afterTs` always advances — no infinite loop,
 * no repeat).
 */
export function computeNextRun(spec: CronSpec, tz: string, afterTs: number): number {
  if (spec.kind === "interval") return afterTs + spec.ms;
  const interval = parseExpression(spec.expr, { currentDate: new Date(afterTs), tz });
  return interval.next().toDate().getTime();
}

/**
 * How the app's `crons.ts` reaches this component (Task 5 design decision):
 *
 * The brief's straw man was a magic file-discovery mechanism ("the E2E-facing convention — a
 * `crons.ts` file default-exporting `cronJobs()`"), but nothing in `packages/component`'s compose
 * flow (`composeComponents`/`defineComponent`) loads app files by convention — components are
 * plain data (`ComponentDefinition`) assembled by whatever calls `composeComponents`, and the
 * only place with actual filesystem/module-loading responsibility is `packages/cli` (not touched
 * this task). Wiring "auto-discover `crons.ts`" now would mean guessing at that not-yet-built
 * CLI's shape.
 *
 * Chosen instead — the least invasive sound option: `defineScheduler(opts?: { crons? })` takes
 * the ALREADY-BUILT `CronJobs` registry (whatever the app's `crons.ts` produced by calling
 * `cronJobs()` + `.interval()`/`.cron()`/etc. and `export default`ing) as a plain config value,
 * exactly like `defineComponent`'s other config fields. The Convex-parity file shape (`import {
 * cronJobs } from "./_generated/server"; const crons = cronJobs(); ...; export default crons;`)
 * is UNCHANGED and still the file an app author writes — Task 6 (or the CLI) just needs to
 * `import crons from "./crons"` and pass it to `defineScheduler({ crons })` in the app's compose
 * step, which is a few lines of glue, not a new loading mechanism. This keeps `@stackbase/
 * scheduler` itself free of filesystem/module-resolution concerns (which belong in `packages/
 * cli`), while the public authoring convention Task 6 needs is already fully exercised by this
 * task's tests (`cronJobs()` → `defineScheduler({ crons })`).
 */
export async function reconcileCrons(ctx: BootContext, registry: CronJobs | undefined): Promise<void> {
  const db = ctx.db;
  const now = ctx.now;
  const nowFn = (): number => now;
  const tables: EnqueueTables = { jobs: "jobs", jobArgs: "job_args", signals: "signals" };

  const desired = registry ? registry.__entries() : [];
  const desiredByName = new Map(desired.map((e) => [e.name, e]));

  const existingRows = await db.query("crons", "by_creation").collect();
  const existingByName = new Map(existingRows.map((r) => [r.name as string, r]));

  // Removed: the app no longer registers this cron. Best-effort cancel its pending cadence job
  // (so it stops self-rescheduling) and drop the row. Already-enqueued work jobs are left alone —
  // they're ordinary `jobs` rows now, disconnected from this cron's identity.
  for (const row of existingRows) {
    if (desiredByName.has(row.name as string)) continue;
    const cadenceJobId = row.cadenceJobId as string | undefined;
    if (cadenceJobId !== undefined) {
      const job = await db.get(cadenceJobId);
      if (job !== null && job.state === "pending") {
        await db.replace(cadenceJobId, { ...job, state: "canceled", completedTs: now });
      }
    }
    await db.delete(row._id as string);
  }

  for (const entry of desired) {
    const specJson = JSON.stringify(entry.spec);
    const existingRow = existingByName.get(entry.name);

    if (existingRow === undefined) {
      // New cron: insert the row, anchor its cadence at `now` (boot time — see `_cronTick`'s
      // clock-anchoring: the anchor is whatever `lastScheduledTs` says, so setting it here
      // rather than leaving it `undefined` means even the FIRST fire is anchored to a fixed
      // instant, not to whatever `now()` happens to be when the cadence job is dispatched).
      const cronId = await db.insert("crons", {
        name: entry.name,
        spec: specJson,
        tz: entry.tz,
        catchUp: entry.catchUp,
        lastScheduledTs: now,
        workFnPath: entry.workFnPath,
        workArgs: entry.workArgs,
      });
      const firstRun = computeNextRun(entry.spec, entry.tz, now);
      const cadenceJobId = await enqueueInternal(db, nowFn, tables, "scheduler:_cronTick", { cronName: entry.name }, { runAt: firstRun });
      await db.replace(cronId, {
        name: entry.name,
        spec: specJson,
        tz: entry.tz,
        catchUp: entry.catchUp,
        lastScheduledTs: now,
        workFnPath: entry.workFnPath,
        workArgs: entry.workArgs,
        cadenceJobId,
      });
      continue;
    }

    const specChanged =
      existingRow.spec !== specJson ||
      existingRow.tz !== entry.tz ||
      existingRow.workFnPath !== entry.workFnPath ||
      JSON.stringify(existingRow.workArgs) !== JSON.stringify(entry.workArgs);

    if (specChanged) {
      // Cadence/target changed: cancel the old cadence job (if still pending) and restart the
      // cadence anchored at `now`, same as a fresh registration — an in-place spec edit
      // shouldn't inherit the OLD spec's phase.
      const oldCadenceJobId = existingRow.cadenceJobId as string | undefined;
      if (oldCadenceJobId !== undefined) {
        const job = await db.get(oldCadenceJobId);
        if (job !== null && job.state === "pending") {
          await db.replace(oldCadenceJobId, { ...job, state: "canceled", completedTs: now });
        }
      }
      const firstRun = computeNextRun(entry.spec, entry.tz, now);
      const cadenceJobId = await enqueueInternal(db, nowFn, tables, "scheduler:_cronTick", { cronName: entry.name }, { runAt: firstRun });
      await db.replace(existingRow._id as string, {
        ...existingRow,
        spec: specJson,
        tz: entry.tz,
        catchUp: entry.catchUp,
        workFnPath: entry.workFnPath,
        workArgs: entry.workArgs,
        lastScheduledTs: now,
        cadenceJobId,
      });
      continue;
    }

    if (existingRow.catchUp !== entry.catchUp) {
      // Policy-only change: doesn't touch the cadence's phase, just the row's `catchUp` field —
      // `_cronTick` reads it fresh on its next fire.
      await db.replace(existingRow._id as string, { ...existingRow, catchUp: entry.catchUp });
    }

    // Idempotent-across-restarts: only (re)schedule a cadence job if this cron doesn't already
    // have one live. A restart that re-runs boot with an unchanged registry must NOT double the
    // cadence — `cadenceJobId` names the single currently-pending cadence job, if any.
    const cadenceJobId = existingRow.cadenceJobId as string | undefined;
    let hasLiveCadence = false;
    if (cadenceJobId !== undefined) {
      const job = await db.get(cadenceJobId);
      hasLiveCadence = job !== null && job.state === "pending";
    }
    if (!hasLiveCadence) {
      const anchor = (existingRow.lastScheduledTs as number | undefined) ?? now;
      const nextRun = computeNextRun(entry.spec, entry.tz, anchor);
      const newCadenceJobId = await enqueueInternal(db, nowFn, tables, "scheduler:_cronTick", { cronName: entry.name }, { runAt: nextRun });
      await db.replace(existingRow._id as string, { ...existingRow, cadenceJobId: newCadenceJobId });
    }
  }
}
