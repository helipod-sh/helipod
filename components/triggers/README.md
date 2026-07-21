# @helipod/triggers

React to committed data changes server-side: `defineTriggers` runs a function of yours with batches of changes whenever documents in a watched table are inserted, updated, or deleted — implemented as a durable cursor over the database's own change log, so a missed change is impossible by construction.

## Install

```sh
bun add @helipod/triggers
```

## Enable

Components are opt-in per project. Each key in `defineTriggers(opts)` is a watched table name from your `schema.ts`; its `handler` is an internal (`_`-prefixed) mutation or action path:

```ts
// helipod.config.ts
import { defineConfig } from "@helipod/component";
import { defineTriggers } from "@helipod/triggers";

export default defineConfig({
  components: [
    defineTriggers({
      messages: { handler: "audit:_onChange" },
      users: { handler: "audit:_onUserChange", fromStart: true },
    }),
  ],
});
```

Per-trigger options: `handler` (required), `batchSize` (default 64), `fromStart` (replay the table's full history instead of starting at the current tip), and `maxDeliveriesPerWindow` (circuit-breaker threshold, default 1000).

## Usage

The handler is an ordinary internal function receiving `{ changes: LogChange[] }` — for example, a durable audit log (from `examples/chat`):

```ts
// helipod/audit.ts
import { mutation } from "./_generated/server";
import type { LogChange } from "@helipod/component";

export const _onChange = mutation<{ changes: LogChange[] }, null>({
  handler: async (ctx, { changes }) => {
    for (const change of changes) {
      await ctx.db.insert("auditLog", {
        changeId: change.changeId,
        table: change.table,
        docId: change.id,
        op: change.op,
      });
    }
    return null;
  },
});
```

## Features

- Durable delivery with no queue: a trigger is a cursor over the storage log, so changes committed while the trigger (or the whole server) was down are delivered on resume.
- At-least-once, in-order per document; every change carries a stable `changeId` (`<table>:<id>:<ts>`) for idempotent dedup across redelivery.
- Handlers can be mutations (reactive writes: counters, audit tables, chaining into workflows) or actions (external side effects: webhooks, sync to other systems).
- Batched invocations (`batchSize`), with `fromStart: true` to replay a table's entire existing history through a new trigger.
- Safety rails: a trigger pauses itself after 8 consecutive handler failures (un-pause with the `triggers:resume` mutation), and a deliveries-per-window circuit breaker stops a self-triggering handler from melting the node.
- Boot-time validation: an unknown handler path, a non-internal function, or the wrong function kind fails fast at startup, not at first delivery.
- Purely declarative — no `ctx.triggers` facade; the watched-table config above is the whole surface.

Depends on `@helipod/scheduler` as a library (it reuses its backoff utilities), but does not require the scheduler component to be composed in your config.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
