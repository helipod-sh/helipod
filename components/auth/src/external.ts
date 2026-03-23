import { mutation, action, httpAction, type RegisteredFunction } from "@stackbase/executor";
import type { AuthConfig } from "./config";

/**
 * A3 external-identity module set (spec Parts 1-5). Task 2 wires the conditional-registration
 * plumbing: `makeAuthModules` (functions.ts) calls `makeExternalModules(config)` whenever `oauth`
 * or `jwt` is configured, and the SET of keys registered here is what `external-config.test.ts`
 * pins as the observable contract. Task 3 (`oauthState`/`/start`), Task 4
 * (`_resolveExternalIdentity`'s real resolution/linking matrix), Task 5 (`/callback` + token
 * exchange + `oauthHandoff` + `completeOAuthSignIn`), and Task 6 (`signInWithIdToken` + jose JWKS
 * verify) replace each placeholder body below with the real implementation — the registration
 * shape (which keys exist, under which config) does not change.
 */

const NOT_IMPLEMENTED = "not implemented — lands in a later A3 task";

export function makeExternalModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const modules: Record<string, RegisteredFunction> = {};

  // Shared by both the OAuth callback and signInWithIdToken (spec Part 3) — registered whenever
  // EITHER oauth or jwt is configured, since both paths funnel through it.
  if (config.oauth || config.jwt) {
    modules._resolveExternalIdentity = mutation(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 4
    });
  }

  if (config.oauth) {
    // One httpAction backs both logical routes (`/start` + `/callback`), mounted at the single
    // `/api/auth/oauth/` prefix declared in component.ts's `httpRoutes` (Task 3/5 parse
    // `<provider>/<phase>` from the path suffix).
    modules.oauthHttp = httpAction(async (): Promise<Response> => {
      return new Response(NOT_IMPLEMENTED, { status: 501 }); // Task 3 (/start) + Task 5 (/callback)
    });
    modules._startOAuth = mutation(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 3
    });
    modules._consumeOAuthState = mutation(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 3/5
    });
    modules._consumeHandoff = mutation(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 5
    });
    modules.completeOAuthSignIn = action(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 5
    });
  }

  if (config.jwt) {
    modules.signInWithIdToken = action(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 6
    });
  }

  return modules;
}
