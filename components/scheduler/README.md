# @helipod/scheduler

Durable scheduled functions for helipod: run a mutation or action later, at an exact time, or on a recurring cron cadence — stored as rows in your database, dispatched by a background driver that survives restarts.

## Install

```sh
bun add @helipod/scheduler
```

## Enable

Components are opt-in per project. Compose the scheduler in `helipod.config.ts`:

```ts
// helipod.config.ts
import { defineConfig } from "@helipod/component";
import { defineScheduler } from "@helipod/scheduler";

export default defineConfig({
  components: [defineScheduler()],
});
```

To add recurring jobs, declare them with `cronJobs()` (typically in `helipod/crons.ts`) and pass the registry via `defineScheduler({ crons })`:

```ts
const crons = cronJobs();
crons.interval("cleanup", { minutes: 5 }, "maintenance:_purge", {});
crons.cron("nightly", "0 3 * * *", "reports:_build", {}, { tz: "America/New_York" });
```

## Usage

Once composed, `ctx.scheduler` is available in every mutation (and, via a delegating facade, every action):

```ts
export const notifyLater = mutation({
  handler: async (ctx, { userId }) => {
    const jobId = await ctx.scheduler.runAfter(60_000, "reminders:_send", { userId });
    // or: await ctx.scheduler.runAt(new Date("2026-08-01T09:00:00Z"), "reminders:_send", { userId });
    // later: await ctx.scheduler.cancel(jobId);
    return jobId;
  },
});
```

## Features

- `ctx.scheduler.runAfter(delayMs, fnRef, args)` and `runAt(ts, fnRef, args)` — schedule a mutation or action; the job row is written in the calling mutation's own transaction, so the schedule commits or rolls back atomically with your write.
- `ctx.scheduler.cancel(id)` — cancel a pending job, with cascading cancel of child jobs.
- `cronJobs()` recurring schedules: `.interval()`, `.cron()` (with time zones), `.daily()`, `.hourly()`, `.weekly()`, `.monthly()`, reconciled into the `crons` table at boot, with configurable catch-up policies for missed occurrences.
- Retries with exponential backoff; mutations default to 4 attempts, actions to 1 (at-most-once unless you opt in via `retry: { maxFailures }`). Crash-looping jobs are dead-lettered, not re-dispatched forever.
- Lower-level `enqueue(fnRef, args, opts)` with `idempotencyKey`, `onComplete` callbacks, and an opaque `context` value round-tripped to the callback — the primitive other components build on.
- A reactive driver: dispatch wakes on every commit plus a wall-clock timer armed to the earliest pending job. No polling loops, no lost work across restarts.
- Jobs are ordinary rows (`scheduler/jobs`, `scheduler/crons`) — browsable in the dashboard like any other table.

No dependencies on other components; it is the base layer `@helipod/workflow`, `@helipod/triggers`, and `@helipod/notifications` build on.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
