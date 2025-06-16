import { mutation } from "@stackbase/executor";
import type { AuthzContext } from "./context";

interface Assign { userId: string; role: string; scope?: { type: string; id: string } }

/**
 * The permission that authorizes managing role assignments. A role that grants
 * `authz:manage` (e.g. an `admin` role declared with `authz: ["manage"]`) may call
 * `assignRole`/`revokeRole`. Held in a scope, it authorizes management within that scope only.
 */
export const MANAGE_PERMISSION = "authz:manage";

// The module `ctx` carries the composed component facades (see the executor's context-provider
// loop). `authz` is present because this component contributes it; `require` throws "Forbidden: …"
// when the caller lacks the permission in the requested scope.
type WithAuthz = { authz: AuthzContext };

// "" is the reserved sentinel for the global scope (an assignment with scopeType/scopeId = "" grants
// everywhere). Reject a partial or empty explicit scope so a real resource scope can never collide
// with — and silently widen to — the global scope. Omit `scope` entirely for a global assignment.
function assertScope(scope?: { type: string; id: string }): void {
  if (scope && (scope.type === "" || scope.id === ""))
    throw new Error('authz: scope.type and scope.id must be non-empty ("" is reserved for the global scope; omit scope for global)');
}

export const assignRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
  assertScope(scope);
  await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION, scope);
  const st = scope?.type ?? "", si = scope?.id ?? "";
  const existing = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
  if (existing.some((r) => r.role === role)) return null; // idempotent
  await ctx.db.insert("role_assignments", { userId, role, scopeType: st, scopeId: si });
  return null;
});

export const revokeRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
  assertScope(scope);
  await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION, scope);
  const st = scope?.type ?? "", si = scope?.id ?? "";
  const rows = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
  for (const r of rows) if (r.role === role) await ctx.db.delete(r._id as string);
  return null;
});
