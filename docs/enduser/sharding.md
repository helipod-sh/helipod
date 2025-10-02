---
title: Sharding (Write Scale-Out)
---

# Sharding (Write Scale-Out)

> `.shardKey("field")` on a table + `shardBy: "argName"` on a mutation = that table's writes
> partition across multiple shards instead of going through one bottleneck. Same app code at
> every tier — a laptop running `stackbase dev`, a single `stackbase serve`, and a
> [fleet](/deploy/fleet) all run the identical function.

Sharding is Stackbase's answer to the "one writer" ceiling: everything else about the reactive
core — schema, queries, mutations, subscriptions, the client SDK — is completely unchanged. You
opt a table into it with one schema annotation and opt a mutation into writing it with one
function option; an app that never adds either behaves exactly as it always has.

## Declaring a sharded table

Add `.shardKey(field)` to a table definition, naming one of its own fields as the shard key —
every document in that table is routed to a shard based on the value of that field:

```ts
// convex/schema.ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  conversations: defineTable({
    title: v.string(),
  }),
  messages: defineTable({
    conversationId: v.id("conversations"),
    author: v.string(),
    body: v.string(),
  })
    .index("by_conversation", ["conversationId"])
    // The conversation is the shard key: every message in a conversation lands on the
    // same shard, so a single-writer-per-conversation workload scales past one writer.
    .shardKey("conversationId"),
});
```

## Routing a mutation with `shardBy`

A mutation that writes a sharded table must declare `shardBy`, naming the arg whose value
identifies the shard (or a resolver function for a derived key):

```ts
// convex/messages.ts
import { v } from "@stackbase/values";
import { mutation, query } from "./_generated/server";

export const send = mutation({
  args: { conversationId: v.id("conversations"), author: v.string(), body: v.string() },
  shardBy: "conversationId",
  handler: (ctx, args) =>
    ctx.db.insert("messages", { conversationId: args.conversationId, author: args.author, body: args.body }),
});

export const list = query({
  handler: (ctx, args: { conversationId: string }) =>
    ctx.db.query("messages", "by_conversation").eq("conversationId", args.conversationId).collect(),
});
```

`shardBy` can also be a function of the mutation's args, `(args) => keyValue`, for a shard key
that isn't itself a top-level argument. Either way, resolution happens server-side, before the
mutation runs — the client never chooses or even knows about shards. `client.mutation(api.messages.send, { conversationId, author, body })` looks identical whether `messages` is sharded or not.

Codegen cross-checks the common case (`shardBy` naming a plain arg) at build time, so a mismatch
is caught before it ever reaches the runtime guards below:

- **No args validator at all**: `"messages:send: declares shardBy: \"conversationId\", but has no args validator — add args: { conversationId: v.<type>(), ... } so codegen (and the runtime) can confirm \"conversationId\" is a required argument every call must supply."`
- **`shardBy` names an arg that isn't declared**: `"...declares shardBy: \"conversationId\", but \"conversationId\" is not one of its declared args (author, body) — add it to args, or point shardBy at a declared argument."`
- **The named arg is optional**: `"...shardBy argument \"conversationId\" is declared with v.optional(...) — a shard key must be required (every call must resolve to exactly one shard). Remove the optional wrapper..."`
- **Type mismatch with the table's shard key** (only checked when exactly one table shards by a
  field of the same name): `"...shardBy argument \"conversationId\" has type string, but table \"messages\" shards by \"conversationId\" of type Id<\"conversations\"> — the two must match so every write routes to the shard its own document belongs on."`

## The rules

A sharded mutation runs entirely on one shard. The engine enforces this with a small set of
always-on guards — they fire identically whether you're on a laptop running `stackbase dev`, a
single `stackbase serve`, or a multi-node fleet, so a shard mistake is a dev-time error, not a
production surprise.

**1. Writing a sharded table requires `shardBy`.** A mutation with no `shardBy` runs on the
default shard and may not write a sharded table at all:

> `table 'messages' is sharded by 'conversationId', but this mutation does not declare a shard, so it runs on the 'default' shard and may not write sharded tables. Add shardBy: 'conversationId' to the mutation so its writes route to a single shard.`

**2. Every write in the mutation must route to its own shard.** Inserting, replacing, or
deleting a document whose shard-key value routes somewhere else is rejected:

> `table 'messages' is sharded by 'conversationId'; this mutation runs on shard s3 but the document (conversationId="conv_9f...") routes to shard s5. Perform this insert from a mutation whose shardBy resolves to that 'conversationId' value (each mutation writes exactly one shard).`

**3. The shard-key field is immutable after insert.** Changing it would move the document to a
different shard, which the engine refuses:

> `cannot change the shard-key field 'conversationId' of a 'messages' document ("conv_1" → "conv_2"): it is immutable after insert. Delete the document and insert a new one to move it between shards.`

**4. A sharded mutation can only read rows of its own shard from a sharded table.** A direct
`db.get` on a foreign-shard document is rejected:

> `table 'messages' is sharded by 'conversationId'; this mutation runs on shard s3 but read a document (conversationId="conv_9f...") that lives on shard s5. A sharded mutation may only read rows of its own shard — read foreign-shard data from a query (queries read every shard).`

**5. Scanning its own sharded table requires an index led by the shard key, pinned to its own
value.** An open scan, a scan via any other index, or a scan pinned to a foreign shard's value
are all rejected:

> `table 'messages' is sharded by 'conversationId'; a sharded mutation may only scan it via an index whose first field is 'conversationId' (index 'by_author' starts with 'author'). Scan foreign-shard data from a query, or define an index on ['conversationId', …] and pin it with .eq('conversationId', <its value>).`
>
> `table 'messages' is sharded by 'conversationId'; a sharded mutation must pin its scan to one shard with .eq('conversationId', <value>) as the first range constraint (an open scan would cross shards). Scan across shards from a query instead.`
>
> `table 'messages' is sharded by 'conversationId'; this mutation runs on shard s3 but the scan is pinned to 'conversationId'=<value>, which routes to shard s5. A sharded mutation may only scan its own shard — read other shards from a query.`

**6. A sharded mutation can freely read and write its own shard, freely read unsharded (global)
tables, and freely INSERT into them — but it may not modify (replace/delete) an unsharded doc.**
Reading its own shard and reading globals need nothing special. Writing a global table is
*insert-only*: an insert is fork-free (a brand-new document with a unique id — there's no existing
version for two shards to race on), so a sharded mutation may add rows to a global table. But a
**replace or delete of an existing unsharded document must come from a mutation without `shardBy`
(the default shard)**, which owns every global doc's read-modify-write. Attempting a global
replace/delete from a sharded mutation is an instructive error:

> `table 'settings' is not sharded, so its documents are owned by the 'default' shard; a replace of one must run on the default shard, but this mutation runs on shard s3. Run this update from a mutation without shardBy (which runs on the default shard), or restructure so the sharded mutation only INSERTS into 'settings' (inserts are allowed from any shard).`

The reason is the same one-writer-per-document invariant that governs sharded tables: a global doc
is owned by the default ring, so letting shard `s3` and shard `s5` both read-modify-write the same
global row would fork its version chain and silently lose one update. Inserts don't have that
hazard (nothing to fork); replaces and deletes do.

Cross-shard writes and cross-shard reads of a sharded table, from inside one mutation, are
rejected by design — cross-shard transactions aren't supported. If your mutation genuinely needs
to touch more than one shard's worth of a sharded table in a single atomic write, that's not
something this feature does; restructure the write, or use the escape hatch below and accept the
single-writer ceiling for that mutation.

## Consistency: what's serialized and what isn't

- **Within a shard, mutations are fully serializable** — the same guarantee Stackbase has always
  given a single writer, unchanged.
- **A sharded mutation's reads of unsharded (global) tables are a stable snapshot, not
  serialized against concurrent global writes.** This is a deliberate, documented trade-off:
  a global table can be written from any shard's mutations, so serializing every sharded
  mutation's global reads against every other shard's global writes would reintroduce the
  single-writer bottleneck sharding exists to remove. In practice this opens a narrow write-skew
  window — concretely: **a permission that was just revoked in a global `permissions`/`users`
  table can still read as effective inside a sharded mutation for a brief window** (typically in
  the tens of milliseconds), the same class of lag you already accept with a bearer token or JWT
  that isn't checked against a live revocation list on every call. If a mutation's correctness
  depends on a global read being perfectly up to date with concurrent global writes, either move
  that check to the default shard (see the escape hatch below) or design for the lag the same way
  you would for any cached-credential check.
- **Queries and subscriptions are untouched by any of this.** They always read a single,
  consistent snapshot across every shard — a live query spanning data from multiple shards can
  never show one shard's effect before another shard's cause, and never returns a torn or
  partially-updated view. There's no new consistency model to learn on the read side; this
  guarantee predates sharding and sharding doesn't weaken it.

## The escape hatch: full serializability

Don't declare `shardBy` on a mutation and it runs on the default shard. This is the *owning ring
for every unsharded (global) document*: all replaces and deletes of global docs happen here, so
they are fully serializable **against one another** — every read-modify-write of global state goes
through this single writer, exactly like Stackbase's original single-writer semantics. Use this for
any mutation whose correctness needs a serialized view of global state that it also modifies (an
admin operation, a rare cross-cutting invariant check) — you give up the shards' parallel write
throughput for that one mutation, not for the whole app.

One honest caveat: a default-shard mutation is serialized against every other *global* write, but
sharded mutations may still **insert** new rows into global tables from their own rings (inserts are
fork-free, so they're allowed everywhere — see rule 6). Those cross-ring inserts are *not* part of a
default mutation's OCC validation: a range scan a default mutation runs over a global table sees a
stable snapshot and won't abort-and-retry just because a sharded mutation inserted a matching row on
another ring at the same instant (a phantom-read-class window, the same phantom class queries always
tolerate). So "fully serialized" holds for the read-modify-write of existing global docs — the thing
the default shard exists to give you — but not against concurrent *inserts* originating on other
shards. If a default mutation's correctness hinges on seeing a just-inserted global row from another
shard within the same transaction, that ordering isn't guaranteed; design for it the way you would
any eventually-consistent insert.

## How many shards: `NUM_SHARDS`

The shard count is a deployment-wide constant, not a per-table or per-app setting:

- **Default: 8 shards.** Applies whether you're running `stackbase dev`, a single `stackbase
  serve`, or a fleet — an app with no `.shardKey`/`shardBy` anywhere never notices, since every
  document and every mutation resolves to the same `"default"` shard either way.
- **Set it explicitly with `STACKBASE_FLEET_SHARDS`** (an environment variable, positive integer)
  before the very first boot of a deployment. It's read once, at first boot, and persisted —
  every later boot of that same deployment reads the persisted value back, regardless of what
  `STACKBASE_FLEET_SHARDS` is set to at the time.
- **The shard count is immutable after first boot.** If `STACKBASE_FLEET_SHARDS` is set to a
  value that disagrees with what's already persisted, boot fails fast rather than silently
  picking one:

  > `stackbase: STACKBASE_FLEET_SHARDS=16 conflicts with the shard count already persisted for this deployment (8, set at first boot). The shard count is immutable after first boot — changing it live isn't supported; resharding is a planned offline tool. Unset STACKBASE_FLEET_SHARDS, or set it to 8 to match the existing deployment.`

  Resharding an existing deployment to a different shard count is a planned offline tool, not
  something you do by flipping this variable — pick a number generously up front if you expect to
  need write parallelism, since growing into it later isn't a live operation yet.

## `stackbase dev` runs the same shards

`stackbase dev` doesn't simulate sharding with a single default shard and call it done — it runs
the full shard count (8 by default) as separate virtual shards inside the one local process, with
every rule above fully live. That means a `shardBy` mistake, a cross-shard read, or an immutable
shard-key change errors on your laptop the same way it would in production — there's no
dev-green/prod-red gap where sharding bugs only show up after a real deploy. An app that never
opts into `.shardKey`/`shardBy` runs byte-identical to before; the virtual shards exist but are
never exercised.

## On a fleet

A [fleet](/deploy/fleet) node running `stackbase serve --fleet` commits a sharded table's writes
across its shards in parallel, through separate per-shard connections to the shared Postgres
database — write throughput for a sharded table scales with shard count instead of being capped
at one writer's throughput. Today this parallelism happens on **one writer node**; distributing
different shards' write ownership across *different* nodes in the fleet is a follow-on step, not
part of this release — see [Fleet (Multi-Node)](/deploy/fleet#sharding) for the current status
and what's next.

## Related

- [Fleet (Multi-Node)](/deploy/fleet) — the multi-node deployment story sharding builds on.
- [Schema & Data Models](/build/schema) — the rest of `defineTable`'s API (`.index()`, etc.), of
  which `.shardKey()` is one more option.
- `examples/chat` (`convex/schema.ts`, `convex/messages.ts`) — the reference pattern this guide's
  code samples are taken from, runnable end-to-end.
