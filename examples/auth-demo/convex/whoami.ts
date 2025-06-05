import { query } from "@stackbase/executor";

/**
 * Protected query: returns the current user's id from the auth context facade, or null if
 * unauthenticated. The auth context provider is injected by composeComponents; we access it
 * via the `auth` key on ctx — typed through `unknown` because the executor ctx type is generic.
 */
export const get = query(
  async (ctx) =>
    (ctx as unknown as { auth: { getUserId(): Promise<string | null> } }).auth.getUserId(),
);
