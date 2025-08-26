---
title: Schema & Data Models
---

# Schema & Data Models

> Schema works the same as Convex - define tables in convex/schema.ts.

Stackbase uses the same schema system as Convex, exposed through native `@stackbase/*` imports. Define your tables in `convex/schema.ts` using `defineSchema` and `defineTable`.

## Quick example

```ts
// convex/schema.ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  tasks: defineTable({
    title: v.string(),
    status: v.union(v.literal("open"), v.literal("done")),
    assigneeId: v.optional(v.id("users")),
  })
    .index("by_status", ["status"])
    .index("by_assignee", ["assigneeId"]),

  users: defineTable({
    name: v.string(),
    email: v.string(),
  }).index("by_email", ["email"]),
});
```

## Convex documentation

For complete schema documentation, see:

- [Schemas](https://docs.convex.dev/database/schemas) - Table definitions and enforcement
- [Validators](https://docs.convex.dev/functions/validation) - `v.string()`, `v.number()`, etc.
- [Indexes](https://docs.convex.dev/database/indexes) - Query optimization
- [Search Indexes](https://docs.convex.dev/text-search) - Full-text search
- [Vector Indexes](https://docs.convex.dev/vector-search) - Semantic search

## Stackbase-specific notes

### Adapter compatibility

All schema features work across Stackbase's storage adapters:

| Feature | DO SQLite | D1 | Bun SQLite | Node SQLite |
|---------|-----------|-----|------------|-------------|
| Tables & fields | Yes | Yes | Yes | Yes |
| Indexes | Yes | Yes | Yes | Yes |
| Search indexes | Yes | Yes | Yes | Yes |
| Vector indexes | Basic | Basic | Basic | Basic |

### Vector index limitations

Built-in adapters use **exact (brute-force) vector search**, which means:
- Works well for small to medium datasets (up to ~10,000 vectors)
- Query time grows linearly with dataset size
- 100% recall accuracy (no approximation)

For production vector workloads at scale, implement a custom docstore adapter that delegates to an external vector database (Pinecone, TurboPuffer, pgvector, etc.). See [Data Storage & Search](/build/data-search#vector-search) for details.

### Schema enforcement

Schema validation runs at the Stackbase core level, so it works identically regardless of which runtime or adapter you use.

## Common questions

- **Are there any schema differences from Convex?** No, schemas work identically.
- **Do I need to run migrations?** No automatic migrations - manage data changes manually as with Convex.

---

