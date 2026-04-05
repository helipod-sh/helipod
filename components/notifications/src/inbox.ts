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
 * own `ctx.notifications.identity()` facade (also attached to every ctx). A user can therefore only
 * ever read/mutate their own inbox — the recipient id is never a client-supplied argument.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callerId(ctx: any): Promise<string | null> {
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
