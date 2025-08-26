---
title: Backend Functions
---

# Backend Functions

> Queries, mutations, and actions work the same as Convex.

Write queries, mutations, and actions in `convex/`. Function definitions and the runtime API are identical to Convex.

## Convex documentation

For complete function documentation, see:

- [Queries](https://docs.convex.dev/functions/query-functions) - Read-only functions
- [Mutations](https://docs.convex.dev/functions/mutation-functions) - Read/write functions
- [Actions](https://docs.convex.dev/functions/actions) - Side effects and external APIs
- [Validation](https://docs.convex.dev/functions/validation) - Argument validation with `v`

---

## Quick reference

| Type | Deterministic | DB Access | Network IO |
|------|--------------|-----------|------------|
| Query | Yes | Read | No |
| Mutation | Yes | Read/Write | No |
| Action | No | Via `runQuery`/`runMutation` | Yes |

## Example

```ts
// convex/tasks.ts
import { query, mutation, action } from "./_generated/server";
import { v } from "@stackbase/values";

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.status) {
      return await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", args.status))
        .collect();
    }
    return await ctx.db.query("tasks").collect();
  },
});

export const create = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      title: args.title,
      status: "open",
    });
  },
});

export const sendReminder = action({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.runQuery(api.tasks.get, { id: args.taskId });
    await fetch("https://api.email.com/send", {
      method: "POST",
      body: JSON.stringify({ subject: `Reminder: ${task.title}` }),
    });
  },
});
```

---

## Validating function arguments

Declare an `args` validator to check a function's arguments at runtime and get a
fully-typed handler and client API. Arguments are validated before your handler runs;
a mismatch is rejected with an `ARGUMENT_VALIDATION` error (HTTP 400) and the handler
never executes.

```ts
import { mutation } from "./_generated/server";
import { v } from "@stackbase/values";

export const send = mutation({
  args: { conversationId: v.id("conversations"), body: v.string() },
  handler: async (ctx, args) => {
    // args.conversationId and args.body are typed from the validator.
    return ctx.db.insert("messages", { conversationId: args.conversationId, body: args.body });
  },
});
```

Validation is **opt-in**: a function with no `args` accepts any arguments (unchanged
behavior). The validator is strict — extra, missing-required, or wrong-typed arguments
are all rejected. Use `v.optional(...)` for arguments that may be omitted. `httpAction`
takes a raw `Request` and has no `args` validator.

---

## Stackbase-specific notes

### Determinism enforcement

Stackbase enforces the same determinism rules as Convex to ensure queries and mutations produce identical results when re-executed (important for subscriptions and optimistic updates).

**Blocked in queries and mutations:**

| Operation | Behavior | Alternative |
|-----------|----------|-------------|
| `Math.random()` | Returns seeded deterministic value | Use actions for true randomness |
| `Date.now()` | Returns request timestamp | Consistent within transaction |
| `fetch()` | Throws error | Use actions for HTTP calls |
| `setTimeout()` | Throws error | Use `ctx.scheduler` |
| `crypto.randomUUID()` | Blocked | Use actions or derive from data |

**Example: What gets blocked**

```ts
// This query will fail at runtime
export const badQuery = query({
  handler: async (ctx) => {
    // ERROR: fetch is not allowed in queries
    const response = await fetch("https://api.example.com/data");
    return response.json();
  },
});

// Use an action instead
export const goodAction = action({
  handler: async (ctx) => {
    const response = await fetch("https://api.example.com/data");
    return response.json();
  },
});
```

### Runtime consistency

Functions behave identically across all Stackbase runtimes. The same function code produces the same results whether running on Cloudflare Workers, Bun, or Node.js.

| Runtime | Query | Mutation | Action | Notes |
|---------|-------|----------|--------|-------|
| Cloudflare Workers | Yes | Yes | Yes | Primary deployment target |
| Bun | Yes | Yes | Yes | Fastest local development |
| Node.js | Yes | Yes | Yes | Requires 22.5+ |

This consistency means you can develop locally with Bun and deploy to Cloudflare Workers with confidence that behavior will match.

---

## Common questions

- **Are there any function API differences from Convex?** No, the API is identical.
- **How do I test functions?** Use `stackbase run` from CLI or `convex-test` for unit tests.
- **Can I use internal functions?** Yes, `internalQuery`, `internalMutation`, and `internalAction` work the same.

---

