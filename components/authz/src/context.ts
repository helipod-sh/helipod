import type { ComponentContext } from "@stackbase/executor";
import { roleGrants, type AuthzConfig } from "./roles";

export interface AuthzContext {
  can(permission: string, scope?: { type: string; id: string }): Promise<boolean>;
  require(permission: string, scope?: { type: string; id: string }): Promise<void>;
  roles(scope?: { type: string; id: string }): Promise<string[]>;
  scopesWith(permission: string, type?: string): Promise<string[]>;
}

interface AuthFacade { getUserId(): Promise<string | null> }

export function authzContext(cctx: ComponentContext, config: AuthzConfig): AuthzContext {
  const auth = cctx.components.auth as AuthFacade | undefined;
  async function assignedRoles(scope?: { type: string; id: string }): Promise<string[]> {
    const uid = auth ? await auth.getUserId() : null;
    if (!uid) return [];
    const rows = await cctx.db.query("role_assignments", "byUser").eq("userId", uid).collect();
    const st = scope?.type ?? "", si = scope?.id ?? "";
    return rows
      .filter((r) => (r.scopeType === "" && r.scopeId === "") || (r.scopeType === st && r.scopeId === si))
      .map((r) => r.role as string);
  }
  return {
    async can(permission, scope) {
      for (const role of await assignedRoles(scope)) if (roleGrants(config, role, permission)) return true;
      return false;
    },
    async require(permission, scope) {
      if (!(await this.can(permission, scope))) throw new Error(`Forbidden: ${permission}`);
    },
    async roles(scope) { return assignedRoles(scope); },
    async scopesWith(permission, type) {
      const uid = auth ? await auth.getUserId() : null;
      if (!uid) return [];
      const rows = await cctx.db.query("role_assignments", "byUser").eq("userId", uid).collect();
      const out = new Set<string>();
      for (const row of rows) {
        if (type !== undefined && row.scopeType !== type) continue;
        if (roleGrants(config, row.role as string, permission)) out.add(row.scopeId as string);
      }
      return [...out];
    },
  };
}
