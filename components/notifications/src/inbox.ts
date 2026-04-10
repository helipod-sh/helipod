import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@stackbase/executor";
import { compact } from "./render";

/** An inbox row as returned to the client. */
export interface InboxItem {
  _id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read: boolean;
  readAt?: number;
  createdAt: number;
  messageId: string;
}

/** Default inbox page size. */
export const DEFAULT_INBOX_LIMIT = 50;

/**
 * Resolve the caller's own user id for in-app authorization: `ctx.auth.getUserId()` when auth is
 * composed (the facade is attached to every ctx), else the raw ambient identity via THIS component's
 * own `ctx.notifications.identity()` facade (also attached to every ctx). The recipient id is never a
 * client-supplied ARGUMENT — it's always the resolved caller — so a user cannot name another user's
 * inbox in a query/mutation arg.
 *
 * BOUNDARY: per-user isolation is only as strong as the identity is trustworthy. With `@stackbase/
 * auth` composed (or an upstream token-verifying proxy), `getUserId()` is a verified id and isolation
 * is enforced. WITHOUT either, the fallback `identity()` is the raw, client-asserted `setAuth(...)`
 * bearer token — an unauthenticated client could assert any user id and read/mutate that inbox. This
 * is the platform's identity model (same as scheduler/authz), not a notifications-specific gap; the
 * mechanism here is correct given a trustworthy identity. Compose auth to make the isolation real.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callerId(ctx: any): Promise<string | null> {
  const viaAuth = ctx.auth ? await ctx.auth.getUserId() : null;
  if (viaAuth) return viaAuth as string;
  return (ctx.notifications?.identity?.() as string | null) ?? null;
}

export function makeInboxModules(): Record<string, RegisteredFunction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inbox = query(async (ctx: any, args: { limit?: number }): Promise<InboxItem[]> => {
    const userId = await callerId(ctx);
    if (!userId) return [];
    const rows = await (ctx as QueryCtx).db
      .query("notifications", "byUser")
      .eq("userId", userId)
      .order("desc")
      .take(args?.limit ?? DEFAULT_INBOX_LIMIT)
      .collect();
    // `compact` drops undefined-valued keys (`data`/`readAt` when absent): the WIRE result codec
    // rejects an undefined value ("Cannot encode value of type undefined"), and these are optional.
    return rows.map((r) => compact({
      _id: r._id as string,
      title: r.title as string,
      body: r.body as string,
      data: r.data as Record<string, unknown> | undefined,
      read: r.read as boolean,
      readAt: r.readAt as number | undefined,
      createdAt: r.createdAt as number,
      messageId: r.messageId as string,
    })) as InboxItem[];
  });

  // N1 scale boundary: `unreadCount` (and `markAllRead` below) scan the caller's whole unread set
  // via `.collect()` — no cap. Fine for typical inboxes; at very large unread backlogs the reactive
  // read-set and the markAllRead transaction grow with it. N2: a maintained counter row + paginated
  // clear. (The `inbox` feed IS bounded, by `limit`/DEFAULT_INBOX_LIMIT.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unreadCount = query(async (ctx: any): Promise<number> => {
    const userId = await callerId(ctx);
    if (!userId) return 0;
    const rows = await (ctx as QueryCtx).db.query("notifications", "byUserUnread").eq("userId", userId).eq("read", false).collect();
    return rows.length;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markRead = mutation(async (ctx: any, args: { id: string }): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    const row = await (ctx as MutationCtx).db.get(args.id);
    // Ownership check: a missing or foreign row is a not-found reject — a user can't touch another's inbox.
    if (!row || (row.userId as string) !== userId) throw new Error("notification not found");
    if (row.read !== true) await (ctx as MutationCtx).db.replace(args.id, compact({ ...row, read: true, readAt: ctx.now() }));
    return null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markAllRead = mutation(async (ctx: any): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    const now = ctx.now();
    const rows = await (ctx as MutationCtx).db.query("notifications", "byUserUnread").eq("userId", userId).eq("read", false).collect();
    for (const r of rows) await (ctx as MutationCtx).db.replace(r._id as string, compact({ ...r, read: true, readAt: now }));
    return null;
  });

  return { inbox, unreadCount, markRead, markAllRead };
}
