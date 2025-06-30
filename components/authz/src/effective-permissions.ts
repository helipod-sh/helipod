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

/**
 * Boot/rebuild: if the stored config hash differs from the current config, rebuild the whole
 * effective_permissions index from role_assignments (reconcile every present (user,scope),
 * drop orphans for (user,scope) with no assignment) and stamp the new hash.
 *
 * Transaction read semantics: db.query(...).collect() reads the COMMITTED snapshot.
 * Orphan deletes target (user,scope) tuples that have NO assignment rows; reconcileScope
 * calls target (user,scope) tuples that DO have assignments. These sets are DISJOINT, so
 * the orphan deletes never interfere with reconcileScope reads.
 */
export async function reconcileEffectivePermissions(
  ctx: { db: GuestDatabaseWriter },
  config: AuthzConfig,
): Promise<void> {
  const db = ctx.db;
  const metaRows = await db.query("meta", "by_creation").collect();
  const meta = metaRows[0];
  const current = configHash(config);
  if (meta != null && (meta.configHash as string) === current) return; // steady state — nothing changed

  // Group all role_assignments by (userId, scopeType, scopeId) with their roles
  const assigns = await db.query("role_assignments", "by_creation").collect();
  const scopeMap = new Map<string, { userId: string; scopeType: string; scopeId: string; roles: string[] }>();
  for (const a of assigns) {
    const userId = a.userId as string;
    const scopeType = a.scopeType as string;
    const scopeId = a.scopeId as string;
    const role = a.role as string;
    const key = `${userId}\0${scopeType}\0${scopeId}`;
    const entry = scopeMap.get(key);
    if (entry != null) {
      entry.roles.push(role);
    } else {
      scopeMap.set(key, { userId, scopeType, scopeId, roles: [role] });
    }
  }

  // Drop effective_permissions rows for any (user,scope) that no longer has an assignment
  const allEff = await db.query("effective_permissions", "by_creation").collect();
  for (const e of allEff) {
    const key = `${e.userId as string}\0${e.scopeType as string}\0${e.scopeId as string}`;
    if (!scopeMap.has(key)) await db.delete(e._id as string);
  }

  // Rebuild each assigned (user,scope) from its full set of roles
  for (const s of scopeMap.values()) {
    await reconcileScope(db, config, s.userId, s.scopeType, s.scopeId, s.roles);
  }

  // Stamp the new config hash
  if (meta != null) {
    await db.replace(meta._id as string, { configHash: current });
  } else {
    await db.insert("meta", { configHash: current });
  }
}
