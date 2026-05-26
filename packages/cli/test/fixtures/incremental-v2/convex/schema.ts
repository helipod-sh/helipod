import { v, defineSchema, defineTable } from "@stackbase/values";

// Shared, byte-identical across incremental-v1 and incremental-v2 — the incremental-push E2E
// changes ONLY f2.ts, so this file (and f1.ts) must land in `unchanged` on the v2 delta deploy.
export default defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
});
