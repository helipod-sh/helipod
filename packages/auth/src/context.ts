import type { ComponentContext } from "@stackbase/executor";

/** ctx.auth — resolves the ambient session token to the current user's id. */
export function authContext(cctx: ComponentContext) {
  return {
    getUserId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const [session] = await cctx.db.query("sessions", "byToken").eq("token", token).collect();
      return session ? (session.userId as string) : null;
    },
  };
}
