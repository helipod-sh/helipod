import { v, defineSchema, defineTable } from "@stackbase/values";

// Two tables + indexes — exercises multi-table + index migration in the Slice-5 round-trip gate.
export default defineSchema({
  messages: defineTable({ author: v.string(), body: v.string(), n: v.number() }).index("by_author", ["author"]),
  users: defineTable({ name: v.string(), admin: v.boolean() }).index("by_name", ["name"]),
});
