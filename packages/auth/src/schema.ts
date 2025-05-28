import { defineSchema, defineTable, v } from "@stackbase/values";

export const authSchema = defineSchema({
  users: defineTable({ email: v.string() }).index("byEmail", ["email"]),
  // Uniqueness of (provider, accountId) is enforced by the application-level duplicate guard
  // in signUp, which relies on single-writer OCC serialization. A multi-writer engine (Tier 2+)
  // will require a storage-level unique index on accounts(provider, accountId) to remain race-free.
  accounts: defineTable({
    userId: v.id("users"),
    provider: v.string(),
    accountId: v.string(), // for password: the email
    secret: v.string(),    // "salt:hash"
  }).index("byAccount", ["provider", "accountId"]),
  sessions: defineTable({ userId: v.id("users"), token: v.string() }).index("byToken", ["token"]),
});
