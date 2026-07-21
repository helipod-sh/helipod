# @helipod/values

Helipod's value system: the `v` validator builder, `defineSchema`/`defineTable` schema builders, document `Id` types, and the canonical value model every other Helipod package builds on.

Most users should install the umbrella package [`helipod`](https://www.npmjs.com/package/helipod) instead — it re-exports this package as `helipod/values`.

```sh
bun add helipod   # or: npm install helipod
```

## Usage

```ts
// helipod/schema.ts
import { defineSchema, defineTable, v } from "@helipod/values";

export default defineSchema({
  conversations: defineTable({
    title: v.string(),
  }),
  messages: defineTable({
    conversationId: v.id("conversations"),
    author: v.string(),
    body: v.string(),
  }).index("by_conversation", ["conversationId"]),
});
```

The same `v` validators declare function arguments, and the engine enforces both at runtime: a write that does not match the table's schema, or a call whose arguments do not match the function's `args`, is rejected with a typed error.

## Features

- `v` validator builder: `v.string()`, `v.number()`, `v.boolean()`, `v.id(table)`, `v.object`, `v.array`, `v.union`, `v.literal`, `v.optional`, and more.
- `defineSchema`/`defineTable` with `.index(name, fields)` (including unique indexes) — schema drives both runtime validation and generated `Doc`/`Id` types.
- `Infer<typeof validator>` extracts the TypeScript type a validator describes.
- Typed document ids: `Id<"messages">` is a distinct type per table, and `v.id("conversations")` makes cross-table references type-checked.
- A total order over all values (`compareValues`) and a canonical JSON transport encoding, shared by the engine, the wire protocol, and the client.
- Zero runtime dependencies; safe to import in server functions, the browser, and tooling alike.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
