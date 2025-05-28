import { defineSchema, defineTable, v } from "@stackbase/values";

export const authSchema = defineSchema({
  users: defineTable({ email: v.string() }).index("byEmail", ["email"]),
  accounts: defineTable({
    userId: v.id("users"),
    provider: v.string(),
    accountId: v.string(), // for password: the email
    secret: v.string(),    // "salt:hash"
  }).index("byAccount", ["provider", "accountId"]),
  sessions: defineTable({ userId: v.id("users"), token: v.string() }).index("byToken", ["token"]),
});
