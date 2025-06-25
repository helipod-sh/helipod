import { expandRole, type AuthzConfig } from "./roles";

export const MAX_PATTERNS_PER_ROLE = 1000;

/** A role's granted permission patterns (with inheritance), stored verbatim (wildcards kept). */
export function expandRolePatterns(config: AuthzConfig, role: string): string[] {
  const set = expandRole(config, role, new Set());
  if (set.size > MAX_PATTERNS_PER_ROLE)
    throw new Error(`authz: role "${role}" expands to more than ${MAX_PATTERNS_PER_ROLE} permission patterns`);
  return [...set];
}

/** The <=4 stored patterns that would grant `permission = "res:act"`. */
export function candidateKeys(permission: string): string[] {
  const i = permission.indexOf(":");
  const res = i === -1 ? permission : permission.slice(0, i);
  const act = i === -1 ? "" : permission.slice(i + 1);
  return [...new Set([`${res}:${act}`, `${res}:*`, `*:${act}`, "*:*"])];
}

/** A stable, order-independent hash of the config's roles + permissions (the index version stamp). */
export function configHash(config: AuthzConfig): string {
  const canonical = stableStringify({ roles: config.roles ?? {}, permissions: config.permissions ?? {} });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) { h ^= canonical.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",")}}`;
}
