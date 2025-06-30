import { defineSchema, defineTable, v } from "@stackbase/values";
export const authzSchema = defineSchema({
  role_assignments: defineTable({
    userId: v.string(), role: v.string(), scopeType: v.string(), scopeId: v.string(),
  }).index("byUserScope", ["userId", "scopeType", "scopeId"]).index("byUser", ["userId"]),
  effective_permissions: defineTable({
    userId: v.string(), scopeType: v.string(), scopeId: v.string(), permission: v.string(),
  }).index("byLookup", ["scopeType", "scopeId", "userId", "permission"]).index("byUser", ["userId"]),
  meta: defineTable({ configHash: v.string() }),
});
