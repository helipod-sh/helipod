/**
 * `useNotifications()` / `<Inbox>` — the typed reactive in-app inbox helper (Global Constraints:
 * "the reactive in-app inbox is the flagship"). Wraps the well-known `@stackbase/notifications`
 * component query/mutation paths (`notifications:inbox`/`unreadCount`/`markRead`/`markAllRead`) so
 * consumers get a live feed + unread count + typed mark-read callbacks with zero per-app codegen.
 * Component functions aren't in an app's generated `Api`, so typing lives HERE (well-known paths),
 * while the server-side `ctx.notifications.send` is typed via the component's `contextType`
 * augmentation.
 */
import type { ReactNode } from "react";
import { useQuery, useMutation } from "./react";

/** An inbox row as delivered to the UI (mirrors the server `InboxItem`). */
export interface InboxNotification {
  _id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read: boolean;
  readAt?: number;
  createdAt: number;
  messageId: string;
}

export interface UseNotificationsResult {
  notifications: InboxNotification[];
  unreadCount: number;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const INBOX_PATH = "notifications:inbox";
const UNREAD_PATH = "notifications:unreadCount";
const MARK_READ_PATH = "notifications:markRead";
const MARK_ALL_PATH = "notifications:markAllRead";

/** Live inbox feed + unread count + mark-read callbacks. `undefined` first-frame results coalesce to
 *  `[]`/`0` so consumers never branch on the loading sentinel. */
export function useNotifications(opts?: { limit?: number }): UseNotificationsResult {
  const notifications = useQuery<InboxNotification[]>(INBOX_PATH, { limit: opts?.limit ?? 50 }) ?? [];
  const unreadCount = useQuery<number>(UNREAD_PATH, {}) ?? 0;
  const markReadFn = useMutation<null>(MARK_READ_PATH);
  const markAllFn = useMutation<null>(MARK_ALL_PATH);
  return {
    notifications,
    unreadCount,
    markRead: async (id: string) => { await markReadFn({ id }); },
    markAllRead: async () => { await markAllFn({}); },
  };
}

export interface InboxProps {
  limit?: number;
  /** Render prop — headless: you own the markup, we own the reactive data + callbacks. */
  children: (state: UseNotificationsResult) => ReactNode;
}

/** A headless `<Inbox>` render helper: `<Inbox>{({ notifications, unreadCount, markRead }) => …}</Inbox>`. */
export function Inbox(props: InboxProps): ReactNode {
  return props.children(useNotifications({ limit: props.limit }));
}
