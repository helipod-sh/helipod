---
title: Quickstart
---

# Quickstart

> Create a project by hand, run it, and call your first function. ~5 minutes.

This is the fastest path to a working Stackbase backend. Every command here exists today.

> **There is no scaffolder yet.** `stackbase init` is planned but **not built** — you create the
> `convex/` folder yourself. It's three small files, shown below.

## Prerequisites

- **Bun** (recommended) or **Node.js 22.5+** (run with `--experimental-sqlite`)
- The `@stackbase/values` package for validator helpers. Generated types come from
  `stackbase codegen` / `stackbase dev` — no extra install needed.

## 1) Install the CLI

```bash
npm i -g @stackbase/cli
# or run without installing
npx @stackbase/cli help
```

## 2) Create the project

```bash
mkdir -p my-app/convex && cd my-app
npm init -y
npm i @stackbase/values
```

## 3) Define a schema

Create `convex/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  messages: defineTable({
    body: v.string(),
  }),
});
```

## 4) Add your first functions

Create `convex/messages.ts`:

```ts
import { query, mutation } from "./_generated/server";
import { v } from "@stackbase/values";

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db.query("messages").take(args.limit ?? 10);
  },
});

export const create = mutation({
  args: { body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", { body: args.body });
  },
});
```

`./_generated/server` doesn't exist yet — the next step creates it.

## 5) Generate types

```bash
stackbase codegen --dir convex
```

This writes `convex/_generated/` (typed `Doc`, `Id`, `api`, and the `query`/`mutation`/`action`
builders you just imported). Re-run it whenever your schema or function signatures change —
`stackbase dev` also does this automatically on file changes.

## 6) Start the dev server

```bash
stackbase dev
```

Defaults: port **3000**, `convex/` as the function directory, SQLite at `.stackbase/data.db`. The
runtime (Bun or Node) is auto-detected — there are no `--bun`/`--node`/`--cf` flags.

The dashboard is at **`http://localhost:3000/_dashboard`** — browse data and run functions from
there.

## 7) Call your functions

There's no `stackbase run` command. Use the dashboard's function runner, or `POST /api/run`:

```bash
curl -X POST http://localhost:3000/api/run \
  -H 'content-type: application/json' \
  -d '{"path": "messages:create", "args": {"body": "Hello"}}'

curl -X POST http://localhost:3000/api/run \
  -H 'content-type: application/json' \
  -d '{"path": "messages:list", "args": {"limit": 5}}'
```

From an app, use the client SDK's `useQuery`/`useMutation` instead — that's where reactivity lives.
See [Realtime & Sync](/build/realtime-caching).

## Your project layout

```
convex/              # Your functions (queries/mutations/actions)
  _generated/        # Generated types (stackbase codegen / stackbase dev)
  schema.ts          # Your schema
  messages.ts        # Your functions
stackbase.config.ts  # Optional — only needed to compose components
```

Commit `convex/_generated/`: [`stackbase serve`](/self-hosting) never runs codegen and fails fast
if it's missing.

## Real command list

`stackbase help` is the source of truth:

| Command | What it does |
|---|---|
| `dev` | Run the engine with hot reload + dashboard |
| `serve` | Run the production server (requires `STACKBASE_ADMIN_KEY`) |
| `deploy` | Push `convex/` to a running `serve --allow-deploy` and hot-swap it live |
| `build` | Compile the app to a self-contained executable |
| `migrate` | Migrate a Convex project into Stackbase (imports + report) |
| `codegen` | Regenerate `convex/_generated` types |
| `fleet` / `objectstore` | Reshard a stopped deployment |

## A runnable example

If you'd rather read working code than assemble it, see
[`examples/chat`](../../examples/chat) — reactive queries, pagination, and a real web UI.

## Next steps

**Building**
- [Backend Functions](/build/backend-functions) - Queries, mutations, actions
- [Schema](/build/schema) - Define tables and indexes
- [Realtime & Sync](/build/realtime-caching) - Reactive queries and the client SDK

**Local Development**
- [Dev Server](/local/dev-server) - CLI commands and options
- [Dashboard](/local/dashboard) - Browse data and run functions

**Deployment**
- [Docker Self-Hosting](/self-hosting) - The baseline deployment story
- [Standalone Binary](/deploy/standalone-binary) - Single-file builds
