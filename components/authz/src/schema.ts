import { defineSchema, defineTable, v } from "@helipod/values";
export const authzSchema = defineSchema({
  role_assignments: defineTable({
    userId: v.string(), role: v.string(), scopeType: v.string(), scopeId: v.string(),
  }).index("byUserScope", ["userId", "scopeType", "scopeId"]).index("byUser", ["userId"]),
  effective_permissions: defineTable({
    userId: v.string(), scopeType: v.string(), scopeId: v.string(), permission: v.string(),
  }).index("byLookup", ["scopeType", "scopeId", "userId", "permission"]).index("byUser", ["userId"]),
  meta: defineTable({ configHash: v.string() }),
  relations: defineTable({
    objectType: v.string(), objectId: v.string(), relation: v.string(),
    subjectType: v.string(), subjectId: v.string(), subjectRelation: v.string(),
  }).index("byObject", ["objectType", "objectId", "relation", "subjectType", "subjectId", "subjectRelation"])
    .index("bySubject", ["subjectType", "subjectId", "subjectRelation", "relation"]),
});
