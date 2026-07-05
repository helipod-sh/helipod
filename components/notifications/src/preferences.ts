import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@helipod/executor";
import type { GuestDatabaseReader, GuestDatabaseWriter } from "@helipod/executor";
import type { NotificationsConfig, Channel } from "./config";
import { compact } from "./render";
import { callerId } from "./inbox";

/** A category is critical (bypasses preferences, can't be opted out) iff config marks it so. */
export function isCritical(config: NotificationsConfig, category: string): boolean {
  return config.categories[category]?.critical === true;
}

/**
 * Resolve whether `(userId, category, channel)` is enabled. DEFAULT-ALLOW: no matching row → true.
 * Most-specific wins: a channel-specific row's `enabled` > a category-wide row's (channel absent)
 * `enabled` > true. One `byUserCategory` fetch, resolved in memory. Runs namespaced (bare table).
 */
export async function resolvePreference(db: GuestDatabaseReader, userId: string, category: string, channel: Channel): Promise<boolean> {
  const rows = await db.query("notificationPreferences", "byUserCategory").eq("userId", userId).eq("category", category).collect();
  let categoryWide: boolean | undefined;
  for (const r of rows) {
    if (r.channel === channel) return r.enabled as boolean;        // channel-specific — authoritative
    if (r.channel === undefined || r.channel === null) categoryWide = r.enabled as boolean;
  }
  return categoryWide ?? true;
}

/**
 * Upsert the `(userId, category, channel|∅)` preference row — shared by the registered `setPreference`
 * module (self-service, caller resolved via `callerId`) AND the mutation facade's `setPreference`
 * (`ctx.notifications.setPreference`, caller resolved via the ambient `cctx.identity`) so the two
 * reachable paths can never drift (the "two-transports-one-core" lesson from prior slices).
 */
export async function applySetPreference(
  db: GuestDatabaseWriter, now: number, config: NotificationsConfig, userId: string,
  args: { category: string; channel?: Channel; enabled: boolean },
): Promise<null> {
  if (isCritical(config, args.category) && !args.enabled) {
    throw new Error(`category "${args.category}" is critical and cannot be disabled`);
  }
  // Upsert the (userId, category, channel|∅) row.
  const rows = await db.query("notificationPreferences", "byUserCategory").eq("userId", userId).eq("category", args.category).collect();
  const existing = rows.find((r) => (r.channel ?? null) === (args.channel ?? null));
  if (existing) {
    await db.replace(existing._id as string, compact({ ...existing, channel: args.channel, enabled: args.enabled, updatedAt: now }));
  } else {
    await db.insert("notificationPreferences", compact({ userId, category: args.category, channel: args.channel, enabled: args.enabled, updatedAt: now }));
  }
  return null;
}

/** `setPreference`/`getPreferences` — the caller's OWN preferences (server-resolved identity). */
export function makePreferenceModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setPreference = mutation(async (ctx: any, args: { category: string; channel?: Channel; enabled: boolean }): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    return applySetPreference((ctx as MutationCtx).db as GuestDatabaseWriter, (ctx as MutationCtx).now(), config, userId, args);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getPreferences = query(async (ctx: any): Promise<Array<{ category: string; channel?: Channel; enabled: boolean }>> => {
    const userId = await callerId(ctx);
    if (!userId) return [];
    const rows = await (ctx as QueryCtx).db.query("notificationPreferences", "byUser").eq("userId", userId).collect();
    return rows.map((r) => compact({ category: r.category as string, channel: r.channel as Channel | undefined, enabled: r.enabled as boolean }));
  });

  return { setPreference, getPreferences };
}
