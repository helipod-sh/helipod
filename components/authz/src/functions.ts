import { mutation, type RegisteredFunction, type GuestDatabaseWriter } from "@stackbase/executor";
import type { AuthzContext } from "./context";
import { roleGrants, type AuthzConfig } from "./roles";
import { upsertPatterns, reconcileScope, reconcileEffectivePermissions, candidateKeys } from "./effective-permissions";

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
export function assertScope(scope?: { type: string; id: string }): void {
  if (scope && (scope.type === "" || scope.id === ""))
    throw new Error('authz: scope.type and scope.id must be non-empty ("" is reserved for the global scope; omit scope for global)');
}

export function authzModules(config: AuthzConfig): Record<string, RegisteredFunction> {
  const assignRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
    assertScope(scope);
    await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION, scope);
    const st = scope?.type ?? "", si = scope?.id ?? "";
    const existing = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
    if (!existing.some((r) => r.role === role)) await ctx.db.insert("role_assignments", { userId, role, scopeType: st, scopeId: si });
    await upsertPatterns(ctx.db as unknown as GuestDatabaseWriter, config, userId, role, st, si); // idempotent even if the assignment already existed
    return null;
  });

  const revokeRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
    assertScope(scope);
    await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION, scope);
    const st = scope?.type ?? "", si = scope?.id ?? "";
    // Query BEFORE staging deletes: the query engine reads the committed snapshot and cannot
    // see staged (uncommitted) writes, so compute remaining roles in memory first.
    const rows = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
    const remainingRoles = rows.filter((r) => r.role !== role).map((r) => r.role as string);
    for (const r of rows) if (r.role === role) await ctx.db.delete(r._id as string);
    await reconcileScope(ctx.db as unknown as GuestDatabaseWriter, config, userId, st, si, remainingRoles);
    return null;
  });

  const rebuild = mutation(async (ctx) => {
    await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION);
    await reconcileEffectivePermissions({ db: ctx.db as unknown as GuestDatabaseWriter }, config);
    return null;
  });

  const bootstrapFirstAdmin = mutation(async (ctx, { userId, role }: { userId: string; role: string }) => {
    // 1. Validate role grants manage
    if (!roleGrants(config, role, MANAGE_PERMISSION)) {
      throw new Error(`authz: role "${role}" does not grant ${MANAGE_PERMISSION}`);
    }

    // 2. TOFU gate — reject if ANY admin already exists.
    // Scan effective_permissions; if any row's permission is in candidateKeys(MANAGE_PERMISSION), throw.
    // Note: ctx.db here is the component-scoped writer (same namespace as GuestDatabaseWriter below),
    // so this scan and the upsertPatterns call address the same physical table.
    const manageKeys = new Set(candidateKeys(MANAGE_PERMISSION));
    const allEff = await ctx.db.query("effective_permissions", "by_creation").collect();
    for (const row of allEff) {
      if (manageKeys.has(row.permission as string)) {
        throw new Error("authz: an admin already exists; use assignRole");
      }
    }

    // 3. Seed BOTH tables atomically (same transaction), global scope (scopeType: "", scopeId: "").
    const existing = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", "").eq("scopeId", "").collect();
    if (!existing.some((r) => r.role === role)) {
      await ctx.db.insert("role_assignments", { userId, role, scopeType: "", scopeId: "" });
    }
    await upsertPatterns(ctx.db as unknown as GuestDatabaseWriter, config, userId, role, "", "");

    // 4. Return null
    return null;
  });

  return { assignRole, revokeRole, rebuild, bootstrapFirstAdmin };
}
