/** The one method auth calls on a composed `@helipod/notifications` (duck-typed from the action
 *  ctx as `ctx.notifications`). Auth does NOT depend on `@helipod/notifications`; this is a
 *  structural shape so an auth deployment WITHOUT notifications composed falls back to its own
 *  `EmailProvider`. `critical: true` guarantees the transactional email bypasses the recipient's
 *  notification preferences. */
export interface NotificationsSendFacade {
  send(args: {
    to: { userId?: string; email?: string; phone?: string };
    channels: Array<"email" | "sms" | "in_app">;
    template: { email?: { subject: string; text: string; html?: string } };
    category?: string;
    critical?: boolean;
  }): Promise<{ messageIds: string[] }>;
}
