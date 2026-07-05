import { v, defineSchema, defineTable } from "@helipod/values";

// A minimal reactive fixture — one indexed table, no file storage (§8.9), no components. This is the
// app the real-Cloudflare E2E deploys to prove subscribe -> commit -> push on a real DO.
export default defineSchema({
  messages: defineTable({ conversationId: v.string(), body: v.string() }).index("by_conversation", ["conversationId"]),
});
