import { mutation } from "@stackbase/executor";

interface Assign { userId: string; role: string; scope?: { type: string; id: string } }

export const assignRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
  const st = scope?.type ?? "", si = scope?.id ?? "";
  const existing = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
  if (existing.some((r) => r.role === role)) return null; // idempotent
  await ctx.db.insert("role_assignments", { userId, role, scopeType: st, scopeId: si });
  return null;
});

export const revokeRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
  const st = scope?.type ?? "", si = scope?.id ?? "";
  const rows = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
  for (const r of rows) if (r.role === role) await ctx.db.delete(r._id as string);
  return null;
});
