---
title: Quickstart
---

# Quickstart

> Install the CLI, initialize a project, and run your first function.

This is the fastest path to a working Stackbase backend: install the CLI, initialize a project, run dev, and deploy once.

## Prerequisites

- **Bun** (recommended) or **Node.js 22.5+** (with `--experimental-sqlite` flag)
- The `@stackbase/values` npm package (for validator helpers): `npm i @stackbase/values` (generated types come from `stackbase dev`/`stackbase codegen`, no extra install needed)

## 1) Install the CLI

```bash
npm i -g @stackbase/cli
# or
npx @stackbase/cli --help
```

## 2) Initialize the project

```bash
stackbase init
```

This creates a `convex/` folder with a starter function you can edit.

## 3) Add your first function

Edit `convex/messages.ts` (created by `stackbase init`) or add your own file:

```ts
import { query, mutation } from "./_generated/server";
import { v } from "@stackbase/values";

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    return await ctx.db.query("messages").take(limit);
  },
});

export const create = mutation({
  args: { body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", { body: args.body });
  },
});
```

## 4) Start dev server

```bash
stackbase dev
```

By default, this starts the Bun runtime. Use `--node` for Node.js or `--cf` for Cloudflare dev.

The dashboard is available at `http://localhost:3000/_dashboard` to browse data and run functions.

## 5) Run functions

```bash
stackbase run messages:list '{"limit": 5}'
stackbase run messages:create '{"body": "Hello"}'
```

## 6) Deploy to Cloudflare

```bash
stackbase deploy
```

## Your project layout

```
convex/              # Your UDFs (queries/mutations/actions)
  _generated/        # Auto-generated types (created by stackbase dev / stackbase codegen)
  schema.ts          # Optional schema
stackbase.config.ts    # Optional config
```

> **Note**: `stackbase init` creates the `convex/` folder with starter functions. The `_generated/` directory is created when you first run `stackbase dev` or `stackbase codegen`.

## Next steps

**Local Development**
- [Dev Server](/local/dev-server) - Runtime options, CLI commands
- [Dashboard](/local/dashboard) - Browse data and run functions
- [DevTools](/local/devtools) - Browser extension for debugging

**Building**
- [Backend Functions](/build/backend-functions) - Queries, mutations, actions
- [Schema](/build/schema) - Define tables and indexes
- [Testing](/build/testing) - Unit and E2E testing strategies

**Deployment**
- [Cloudflare](/deploy/cloudflare) - Recommended production deployment
- [Self-Hosted](/deploy/self-hosted) - Railway, Fly.io, Docker

---

