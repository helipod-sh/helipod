import { v, defineSchema, defineTable } from "@stackbase/values";

// A user table with a first-class `Id<"_storage">` field — proves file references flow through a
// normal user document (and its reactive fan-out) exactly like any other id column.
export default defineSchema({
  files: defineTable({ name: v.string(), image: v.id("_storage") }),
});
