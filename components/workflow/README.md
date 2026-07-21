# @helipod/workflow

Durable multi-step workflows for helipod: write a plain async handler that calls steps, and the engine journals every step's outcome and replays deterministically, so a run survives crashes, restarts, and deploys without re-running completed work.

## Install

```sh
bun add @helipod/workflow @helipod/scheduler
```

`@helipod/workflow` requires the scheduler component — every step dispatches through the scheduler's job queue and inherits its retries, backoff, and cascading cancel.

## Enable

Define workflows with `workflow.define` and compose the component alongside `defineScheduler()` in `helipod.config.ts` (composing `defineWorkflow` without the scheduler throws at compose time):

```ts
// helipod.config.ts
import { defineConfig } from "@helipod/component";
import { defineScheduler } from "@helipod/scheduler";
import { defineWorkflow, workflow } from "@helipod/workflow";

const fulfillOrder = workflow.define({
  handler: async (step, { orderId }: { orderId: string }) => {
    await step.runMutation("orders:_reserveStock", { orderId });
    await step.runAction("payments:_charge", { orderId });
    await step.runMutation("orders:_markFulfilled", { orderId });
  },
});

export default defineConfig({
  components: [
    defineScheduler(),
    defineWorkflow({ workflows: { "workflows:fulfillOrder": fulfillOrder } }),
  ],
});
```

## Usage

Start (or cancel) a run from any mutation or action via `ctx.workflow`:

```ts
export const placeOrder = mutation({
  handler: async (ctx, { orderId }) => {
    const runId = await ctx.workflow.start("workflows:fulfillOrder", { orderId });
    return runId;
  },
});
```

## Features

- `workflow.define({ handler })` with `step.runMutation` / `step.runQuery` / `step.runAction` / `step.sleep` / `step.sleepUntil` — each step's result is journaled; advancing a run replays the handler from the top and resolves completed steps instantly from the journal.
- `ctx.workflow.start(ref, args)` / `cancel(runId, opts?)` / `sendEvent(runId, name, payload?)`, callable from mutations and actions alike. `start` writes in the calling mutation's own transaction: if the mutation rolls back, the workflow never started.
- `step.waitForEvent(name)` — a durable external signal: the run parks on an `events` row (no scheduler job) until `ctx.workflow.sendEvent` resolves it.
- Fan-out/fan-in with `Promise.all([step.a(), step.b()])`, bounded by `maxParallelism` (default 16).
- Saga compensation: per-step `{ compensate: FnRef }` handlers unwind in reverse step order on failure, and `cancel` compensates by default (opt out with `{ compensate: false }`). A failed compensation halts the unwind and terminal-fails with both errors preserved.
- Per-step `{ maxAttempts }` retry caps (also applied to that step's compensation), plus workflow-level `onComplete`/`context` round-trip.
- A live `workflow:status` query for observing runs reactively.
- Handlers must be deterministic: no `fetch`, `Math.random()`, or `Date.now()` in the handler body — put non-deterministic work inside a `step.runAction`.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
