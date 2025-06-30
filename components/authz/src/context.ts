import type { ComponentContext } from "@stackbase/executor";
import { type AuthzConfig } from "./roles";
import { candidateKeys } from "./effective-permissions";

export interface AuthzContext {
  can(permission: string, scope?: { type: string; id: string }): Promise<boolean>;
  require(permission: string, scope?: { type: string; id: string }): Promise<void>;
  roles(scope?: { type: string; id: string }): Promise<string[]>;
  scopesWith(permission: string, type?: string): Promise<string[]>;
}

interface AuthFacade { getUserId(): Promise<string | null> }

export function authzContext(cctx: ComponentContext, config: AuthzConfig): AuthzContext {
  const auth = cctx.components.auth as AuthFacade | undefined;
  async function uid(): Promise<string | null> { return auth ? await auth.getUserId() : null; }
  async function assignedRoles(scope?: { type: string; id: string }): Promise<string[]> {
    const u = await uid();
    if (!u) return [];
    const rows = await cctx.db.query("role_assignments", "byUser").eq("userId", u).collect();
    const st = scope?.type ?? "", si = scope?.id ?? "";
    return rows
      .filter((r) => (r.scopeType === "" && r.scopeId === "") || (r.scopeType === st && r.scopeId === si))
      .map((r) => r.role as string);
  }
  async function held(scopeType: string, scopeId: string, userId: string, keys: string[]): Promise<boolean> {
    for (const key of keys) {
      const hit = await cctx.db.query("effective_permissions", "byLookup")
        .eq("scopeType", scopeType).eq("scopeId", scopeId).eq("userId", userId).eq("permission", key).collect();
      if (hit.length > 0) return true;
    }
    return false;
  }
  void config; // config is kept as a parameter for API compatibility; index reads don't need it
  return {
    async can(permission, scope) {
      const u = await uid(); if (!u) return false;
      const keys = candidateKeys(permission);
      const st = scope?.type ?? "", si = scope?.id ?? "";
      if (await held(st, si, u, keys)) return true;
      if (st !== "" || si !== "") return held("", "", u, keys); // fall back to a global grant
      return false;
    },
    async require(permission, scope) {
      if (!(await this.can(permission, scope))) throw new Error(`Forbidden: ${permission}`);
    },
    async roles(scope) { return assignedRoles(scope); },
    async scopesWith(permission, type) {
      const u = await uid(); if (!u) return [];
      const keys = new Set(candidateKeys(permission));
      const rows = await cctx.db.query("effective_permissions", "byUser").eq("userId", u).collect();
      const out = new Set<string>();
      for (const r of rows) {
        if (type !== undefined && r.scopeType !== type) continue;
        if (keys.has(r.permission as string)) out.add(r.scopeId as string);
      }
      return [...out];
    },
  };
}
