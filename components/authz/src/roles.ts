import type { TablePolicy } from "@helipod/executor";

export interface RoleDef { inherits?: string | string[]; [resource: string]: string[] | string | string[] | undefined }
export interface AuthzConfig {
  permissions?: Record<string, string[]>;
  roles?: Record<string, RoleDef>;
  policies?: Record<string, TablePolicy>;
}

/** Does `role` (via inheritance) grant `permission` (a "resource:action" string)? Supports `*`. */
export function roleGrants(config: AuthzConfig, role: string, permission: string): boolean {
  const perms = expandRole(config, role, new Set());
  const [res, act] = permission.split(":");
  for (const p of perms) {
    const [pr, pa] = p.split(":");
    if ((pr === res || pr === "*") && (pa === act || pa === "*")) return true;
  }
  return false;
}

export function expandRole(config: AuthzConfig, role: string, seen: Set<string>): Set<string> {
  const out = new Set<string>();
  const def = config.roles?.[role];
  if (!def || seen.has(role)) return out;
  seen.add(role);
  const inherits = def.inherits ? (Array.isArray(def.inherits) ? def.inherits : [def.inherits]) : [];
  for (const parent of inherits) for (const p of expandRole(config, parent, seen)) out.add(p);
  for (const [resource, actions] of Object.entries(def)) {
    if (resource === "inherits" || !Array.isArray(actions)) continue;
    for (const action of actions) out.add(`${resource}:${action}`);
  }
  return out;
}
