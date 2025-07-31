import { v, defineSchema, defineTable } from "@stackbase/values";

// `stackbase build` fixture: a `notes` table (box, text) with a secondary index — the build E2E's
// compiled-binary app.
export default defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
});
