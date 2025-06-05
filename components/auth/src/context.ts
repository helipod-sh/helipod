import type { ComponentContext } from "@stackbase/executor";

export interface AuthContext {
  getUserId(): Promise<string | null>;
}

/** ctx.auth — resolves the ambient session token to the current user's id. */
export function authContext(cctx: ComponentContext): AuthContext {
  return {
    getUserId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const [session] = await cctx.db.query("sessions", "byToken").eq("token", token).collect();
      if (!session || cctx.now > (session.expiresAt as number)) return null;
      return session.userId as string;
    },
  };
}
