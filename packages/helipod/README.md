# helipod

**The open-source, self-hostable reactive backend.**

Write TypeScript functions. Get a transactional database, live-updating queries,
file storage, scheduling, durable workflows, and auth — on your own
infrastructure, from a single package.

```bash
bun add helipod        # or: npm install helipod
```

## How it works

Queries are live subscriptions. Mutations are serializable transactions. When a
mutation commits, every subscribed client whose query read the affected data is
pushed a fresh result over WebSocket — no polling, no cache invalidation to
manage.

```ts
// helipod/schema.ts
import { defineSchema, defineTable, v } from "helipod/values";

export default defineSchema({
  messages: defineTable({
    channel: v.string(),
    body: v.string(),
  }).index("by_channel", ["channel"]),
});
```

```ts
// helipod/messages.ts
import { query, mutation } from "./_generated/server";
import { v } from "helipod/values";

export const list = query({
  args: { channel: v.string() },
  handler: (ctx, { channel }) =>
    ctx.db.query("messages", "by_channel").eq("channel", channel).collect(),
});

export const send = mutation({
  args: { channel: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", args);
  },
});
```

```tsx
// React — updates in real time when anyone sends
import { useQuery, useMutation } from "helipod/react";
import { api } from "../helipod/_generated/api";

const messages = useQuery(api.messages.list, { channel: "general" });
const send = useMutation(api.messages.send);
```

Run it:

```bash
npx helipod dev   # engine + typed codegen + dashboard + hot reload, SQLite, zero config
```

## What's in the package

| Import | Contents |
| --- | --- |
| `helipod` | Client SDK (`HelipodClient`, auth client, offline outbox) |
| `helipod/react` | `useQuery`, `useMutation`, optimistic updates |
| `helipod/server` | `query`, `mutation`, `action`, `httpAction`, `httpRouter` (re-exported, fully typed, via your app's `_generated/server`) |
| `helipod/values` | `v` validators, `defineSchema`, `defineTable` |
| `helipod/config` | `defineConfig` — compose optional components |
| `helipod` (CLI) | `dev`, `serve`, `deploy`, `build`, `migrate` |

## Optional components

Installed separately, activated in `helipod.config.ts`:

- [`@helipod/auth`](https://www.npmjs.com/package/@helipod/auth) — email/OAuth sign-in, passkeys, TOTP MFA, sessions
- [`@helipod/scheduler`](https://www.npmjs.com/package/@helipod/scheduler) — scheduled functions and cron jobs
- [`@helipod/workflow`](https://www.npmjs.com/package/@helipod/workflow) — durable multi-step workflows with compensation
- [`@helipod/triggers`](https://www.npmjs.com/package/@helipod/triggers) — react to table changes with guaranteed delivery
- [`@helipod/notifications`](https://www.npmjs.com/package/@helipod/notifications) — email/SMS/push/in-app messaging
- [`@helipod/authz`](https://www.npmjs.com/package/@helipod/authz) — role-based authorization

## Deploy anywhere

- `helipod serve` — production server on SQLite or Postgres (`--database-url`)
- `docker compose up` — single-container self-host
- `helipod build` — compile your app into one self-contained executable
- `helipod deploy --target cloudflare|docker|railway|fly|aws` — managed targets
- Offline-capable clients: optimistic updates plus a durable outbox with
  exactly-once replay

## Learn more

- Documentation: https://helipod-six.vercel.app/docs
- Source: https://github.com/helipod-sh/helipod
- Examples: [chat](https://github.com/helipod-sh/helipod/tree/main/examples/chat),
  [auth](https://github.com/helipod-sh/helipod/tree/main/examples/auth-demo),
  [offline](https://github.com/helipod-sh/helipod/tree/main/examples/offline-demo)

License: [FSL-1.1-Apache-2.0](https://github.com/helipod-sh/helipod/blob/main/LICENSE) —
free to use and self-host; each release converts to Apache 2.0 after two years.
