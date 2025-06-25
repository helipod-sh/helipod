import type { GuestDatabaseWriter } from "@stackbase/executor";
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

/** Insert the role's patterns for (user, scope) that aren't already present (idempotent). */
export async function upsertPatterns(
  db: GuestDatabaseWriter, config: AuthzConfig, userId: string, role: string, scopeType: string, scopeId: string,
): Promise<void> {
  const existing = await db.query("effective_permissions", "byLookup").eq("scopeType", scopeType).eq("scopeId", scopeId).eq("userId", userId).collect();
  const have = new Set(existing.map((r) => r.permission as string));
  for (const p of expandRolePatterns(config, role)) if (!have.has(p)) await db.insert("effective_permissions", { userId, scopeType, scopeId, permission: p });
}

/**
 * Recompute (user, scope) effective patterns from the provided remaining roles; insert
 * missing, delete orphans. The caller passes `remainingRoles` directly because the query
 * engine reads the committed snapshot and cannot see staged (uncommitted) deletes made in
 * the same transaction.
 */
export async function reconcileScope(
  db: GuestDatabaseWriter, config: AuthzConfig, userId: string, scopeType: string, scopeId: string,
  remainingRoles: string[],
): Promise<void> {
  const desired = new Set<string>();
  for (const role of remainingRoles) for (const p of expandRolePatterns(config, role)) desired.add(p);
  const rows = await db.query("effective_permissions", "byLookup").eq("scopeType", scopeType).eq("scopeId", scopeId).eq("userId", userId).collect();
  const have = new Set<string>();
  for (const r of rows) {
    if (desired.has(r.permission as string)) have.add(r.permission as string);
    else await db.delete(r._id as string);
  }
  for (const p of desired) if (!have.has(p)) await db.insert("effective_permissions", { userId, scopeType, scopeId, permission: p });
}
