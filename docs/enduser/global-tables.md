---
title: Global Tables (Cloudflare D1)
---

# Global Tables (Cloudflare D1)

> `.global()` on a table = that table lives in Cloudflare D1 instead of a shard's local store, so
> it's the same data no matter which shard (or node) a mutation or query runs on — the right place
> for accounts, unique handles, and other data that has to be consistent everywhere, not partitioned
> like [sharded](/sharding) data is. Cloudflare-only today: it's built on
> `@stackbase/runtime-cloudflare` (`stackbase deploy --target cloudflare`) and requires a D1 binding.

## Why this exists

[Sharding](/sharding) partitions a table's writes across shards so no single writer becomes a
bottleneck — but a sharded (or even unsharded/root) table still lives in one shard's own local
store, which is exactly wrong for data that needs to be **globally unique or globally consistent**:
a `users` table keyed by email, an `orgs` table keyed by slug, an account-lookup table a login flow
needs to hit correctly regardless of which shard is handling the request. `.global()` gives you a
table backed by [Cloudflare D1](https://developers.cloudflare.com/d1/) — a real relational store
with real `CREATE UNIQUE INDEX` constraints — instead of a shard's schemaless per-shard log, so
those constraints and reads are actually global.

Use `.global()` when:
- the table needs a **genuine global-unique constraint** (one email, one handle, one slug — ever,
  across every shard), not just uniqueness within a shard.
- the data must be **the same everywhere**, not partitioned by a shard key (accounts, orgs,
  feature flags, global config).

Don't reach for it as a default. Most tables should stay normal (root) or [sharded](/sharding) —
`.global()` trades away range/sorted/paginated queries and same-mutation writes alongside sharded
data (see [Honest boundaries](#honest-boundaries-what-isnt-here-yet) below) for the one thing only
D1 gives you: a real global-unique constraint.

## Declaring a global table

Add `.global()` to a table definition. It's **mutually exclusive with `.shardKey()`** — a table is
either sharded or global, never both (calling both throws at schema build time: "a table cannot be
both .global() and .shardKey() (global data is not sharded)").

```ts
// convex/schema.ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  accounts: defineTable({
    email: v.string(),
    name: v.string(),
  })
    // { unique: true } on a .global() table is a REAL global-unique constraint (a D1
    // `CREATE UNIQUE INDEX`) — not just a per-shard check like a normal index would give you.
    .index("by_email", ["email"], { unique: true })
    .global(),
});
```

`{ unique: true }` on `.index()` only means "real constraint" on a `.global()` table. The same
option on a sharded table's index is rejected at schema-load time — a per-shard store can't enforce
a constraint across shards it doesn't see, so declaring one there is a schema error, not a silent
no-op.

A `.global()` table can declare as many indexes (unique or not) as it needs, the same `.index(name,
fields, opts?)` call as any other table.

## Reads and writes

Reads and writes against a `.global()` table are routed to D1 automatically — you don't do anything
different in the function body:

```ts
// convex/accounts.ts
import { v } from "@stackbase/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: { email: v.string(), name: v.string() },
  handler: (ctx, { email, name }) => ctx.db.insert("accounts", { email, name }),
});

export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const rows = await ctx.db.query("accounts", "by_email").eq("email", email).collect();
    return rows[0] ?? null;
  },
});
```

`ctx.db.get(id)` and an **equality** index query (`.eq(field, value)`, optionally `.take(n)` to
limit) are supported on a `.global()` table. A same-mutation read of a row you just inserted sees
it (read-your-own-writes), even though the write hasn't hit D1 yet — see
[Honest boundaries](#honest-boundaries-what-isnt-here-yet) for exactly what query shapes beyond
equality aren't supported yet.

A violated unique constraint rejects the mutation with an error naming the table and field, instead
of silently overwriting or duplicating.

## Live subscriptions

A `useQuery` against a `.global()` table is reactive — it updates when the underlying D1 data
changes, including a change written from a **different** node/Durable Object. There's no
`.subscribe()`/`.poll()` call to make on the client; it's the same `useQuery` you'd write for any
other table.

Under the hood this is **poll-based, not instant**: each Durable Object that has at least one live
`.global()`-table subscription checks D1 for changes on a short timer (about every 2 seconds by
default) and pushes an update only when something changed. A node with zero global subscriptions
polls nothing (no idle cost). This means a change to a global table shows up within roughly that
poll interval, not on the same event-loop turn a local (sharded/root) table's write does — see the
next section for what that means for the mutation that made the write.

## Honest boundaries (what isn't here yet)

- **A mutation writes global tables or sharded/root tables, never both.** Writing to a `.global()`
  table and a sharded/root table in the same mutation is rejected before either write lands:
  `"a mutation may write global (.global()) tables or sharded/root tables, but not both in one
  mutation"`. This isn't a bug to work around — a D1 write can't enlist in the same transaction as a
  shard's local commit, so allowing both would admit a partial commit where the two disagree.
  Split the work into two mutations if you need to touch both.
- **Global queries are equality-only.** `.eq(field, value)` (plus `.take(n)`) is all that's
  supported on a `.global()` table today. Range comparisons (`.gt`/`.gte`/`.lt`/`.lte`), `.order()`,
  `.where()` filters, and `.paginate()` are not yet available and fail fast with a clear error
  rather than silently ignoring the unsupported part of the query.
- **No cross-shard fan-out yet.** A `.global()` table's query reads exactly what's in D1 — it
  doesn't merge or join against per-shard data. (You can still read a `.global()` table and a local
  table in the same *query* — the co-write restriction above is a writes-only rule — you just don't
  get an automatic join across them.)
- **The writer doesn't see its own global write update its query any faster than anyone else's.**
  Because global reactivity is poll-based for every subscriber, including the one on the same node
  that made the write, a query subscribed to a `.global()` table updates on the next poll tick
  (~2s), not immediately on commit the way a sharded/root table's subscription does. The mutation's
  own return value/promise resolves normally and correctly the instant it commits — it's specifically
  the *subscription* re-render that lags. If you need the calling client's UI to reflect the write
  instantly, use a [client optimistic update](/optimistic-updates) to render the expected result
  locally while the real push catches up on the next poll.
- **Cloudflare D1 only.** `.global()` requires a D1 binding (`env.DB`), wired through
  `@stackbase/runtime-cloudflare` — i.e. it only works on a deployment made with `stackbase deploy
  --target cloudflare`, with `env.DB` supplied by your Durable Object subclass (see
  [Cloudflare](/deploy/cloudflare)). `stackbase dev`/`stackbase serve` (the SQLite/Postgres
  runtimes) don't have a D1 binding, so any read or write against a `.global()` table there fails
  fast: `"table "…" is .global() but no D1 binding is configured (global tables require Cloudflare
  D1)"`. You can still declare `.global()` tables in a schema you also run locally — the schema
  itself is valid everywhere — you just can't exercise those tables outside a Cloudflare deployment
  yet.
- **Schema changes are create-only.** The D1 tables/indexes for a `.global()` table are created
  fresh from your schema; there's no `ALTER TABLE`-style migration path yet. Treat a `.global()`
  table's shape as fixed once it's live, the same caution you'd apply to any hand-managed relational
  schema.
- **Row-level read policies aren't supported on `.global()` tables yet.** If your app uses row
  policies (authz) elsewhere, they don't apply here — a read policy configured on a `.global()`
  table's read is rejected rather than silently skipped.

None of the above are bugs — they're the current, documented scope of the feature. Each is a
plausible follow-on, not a wall.

## Wiring the D1 binding

`.global()` needs a `d1_databases` binding named `DB` in your `wrangler.jsonc` (this one, unlike the
`durable_objects`/R2 bindings `stackbase deploy --target cloudflare` reconciles for you, is currently
manual — create the database once with `wrangler d1 create <name>` and add the binding yourself):

```jsonc
{
  "d1_databases": [
    { "binding": "DB", "database_name": "my-app-db", "database_id": "…" }
  ]
}
```

Your Durable Object subclass then wraps `env.DB` and passes it through as `d1`:

```ts
// worker.ts
import { StackbaseDurableObject, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare";
import { bindingD1Client, type D1Binding } from "@stackbase/docstore-d1";

export class MyAppDO extends StackbaseDurableObject {
  protected appConfig(env: unknown): DurableObjectAppConfig {
    const db = (env as { DB?: D1Binding }).DB;
    return {
      loaded, // your app's schema + functions, as usual
      adminKey: (env as { STACKBASE_ADMIN_KEY: string }).STACKBASE_ADMIN_KEY,
      ...(db ? { d1: bindingD1Client(db) } : {}),
    };
  }
}
```

The D1 tables/indexes for every `.global()` table are created automatically the first time the
Durable Object boots with a D1 binding present — there's no separate migration step to run.

## Related

- [Sharding (Write Scale-Out)](/sharding) — the write-partitioning feature `.global()` is the
  opposite of: sharding spreads a table's writes across shards, `.global()` keeps a table the same
  everywhere.
- [Cloudflare](/deploy/cloudflare) — the `@stackbase/runtime-cloudflare` Durable-Object deployment
  `.global()` is built on.
- [Optimistic Updates](/optimistic-updates) — how to make a mutation's own UI update feel instant
  even while a `.global()` table's subscription waits for the next poll tick.
