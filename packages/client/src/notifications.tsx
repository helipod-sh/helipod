/**
 * `useNotifications()` / `<Inbox>` — the typed reactive in-app inbox helper (Global Constraints:
 * "the reactive in-app inbox is the flagship"). Wraps the well-known `@helipod/notifications`
 * component query/mutation paths (`notifications:inbox`/`unreadCount`/`markRead`/`markAllRead`) so
 * consumers get a live feed + unread count + typed mark-read callbacks with zero per-app codegen.
 * Component functions aren't in an app's generated `Api`, so typing lives HERE (well-known paths),
 * while the server-side `ctx.notifications.send` is typed via the component's `contextType`
 * augmentation.
 */
import type { ReactNode } from "react";
import type { Value } from "@helipod/values";
import { useQuery, useMutation } from "./react";
import type { HelipodClient } from "./client";

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

/** N3 — a caller's own `(category, channel|category-wide)` preference row, as delivered to the UI
 *  (mirrors the server `getPreferences` return; `channel` absent = category-wide). */
export interface NotificationPreference {
  category: string;
  channel?: "email" | "sms" | "in_app" | "push";
  enabled: boolean;
}

export interface UseNotificationPreferencesResult {
  preferences: NotificationPreference[];
  setPreference: (args: NotificationPreference) => Promise<void>;
}

const PREFS_GET = "notifications:getPreferences";
const PREFS_SET = "notifications:setPreference";

/** N3 — live view of the caller's own notification preferences + a setter. Server-resolved identity
 *  (same ownership model as `useNotifications`'s inbox) — there is no `userId` arg to pass. */
export function useNotificationPreferences(): UseNotificationPreferencesResult {
  const preferences = useQuery<NotificationPreference[]>(PREFS_GET, {}) ?? [];
  const setFn = useMutation<null>(PREFS_SET);
  return {
    preferences,
    setPreference: async (args: NotificationPreference) => {
      await setFn(args as unknown as Record<string, Value>);
    },
  };
}

const REGISTER_PUSH_PATH = "notifications:registerPushToken";
const UNREGISTER_PUSH_PATH = "notifications:unregisterPushToken";

/** Register this device's push token for the CURRENT authenticated caller (self-only, server-
 *  resolved — see `docs/superpowers/specs/2026-04-13-notifications-push-channel-design.md`).
 *  Acquiring the actual OS token (Expo `getExpoPushTokenAsync()`, a native FCM/APNs SDK, or a web
 *  `PushManager.subscribe`) is the caller's responsibility — this is a thin wire call, nothing
 *  more, matching `useNotifications`'s scope boundary for the inbox. A plain async function (not a
 *  hook): registration typically happens once at app-boot/permission-grant time, not on every
 *  render. */
export async function registerForPush(client: HelipodClient, args: { token: string; provider: "expo" | "fcm" | "apns"; platform?: "ios" | "android" | "web" }): Promise<void> {
  await client.mutation(REGISTER_PUSH_PATH, args as unknown as Record<string, Value>);
}

/** Unregister this device's push token (e.g. on sign-out / permission revoke). */
export async function unregisterForPush(client: HelipodClient, args: { token: string }): Promise<void> {
  await client.mutation(UNREGISTER_PUSH_PATH, args as unknown as Record<string, Value>);
}
