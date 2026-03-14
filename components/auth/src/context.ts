import type { ComponentContext } from "@stackbase/executor";
import { resolveSession } from "./functions";

export interface AuthContext {
  getUserId(): Promise<string | null>;
}

/** ctx.auth — resolves the ambient session token to the current user's id. Reads the session row
 *  (byTokenHash, legacy byToken fallback) INSIDE the transaction, so it enters the read-set and a
 *  revoke (row delete) invalidates every subscribed query reactively (spec decision 1). */
export function authContext(cctx: ComponentContext): AuthContext {
  return {
    getUserId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const session = await resolveSession(cctx.db, token);
      if (!session || cctx.now > (session.expiresAt as number)) return null;
      return session.userId as string;
    },
  };
}
