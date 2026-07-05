import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { authSchema } from "./schema";
import { makeAuthModules } from "./functions";
import { authContext } from "./context";
import { resolveAuthConfig, type AuthOptions } from "./config";

/**
 * `defineAuth(options?)` — the `@helipod/auth` component: password + hardened session auth. The
 * module set is built by `makeAuthModules(config)` closing over the resolved TTL config (spec
 * decision 10), following `defineScheduler`'s config-value convention. `ctx.auth.getUserId()`
 * resolves the ambient session token to a user id inside the transaction (read-set → reactive
 * revocation). `context` only reads, so no `contextWrite`.
 */
export function defineAuth(options?: AuthOptions): ComponentDefinition {
  const config = resolveAuthConfig(options);
  return defineComponent({
    name: "auth",
    schema: authSchema,
    modules: makeAuthModules(config),
    context: authContext,
    contextType: { import: "@helipod/auth", type: "AuthContext" },
    ...(config.oauth
      ? {
          // GET backs `/start` + the query-mode callback (Google/GitHub/Microsoft/Discord/Facebook);
          // POST backs Apple's `form_post` callback. Per-method dispatch (`matchComponentRoute`) +
          // per-method overlap guard (`composeComponents`) make the two entries disjoint and
          // unambiguous — same handler, two methods. No engine seam change is needed.
          httpRoutes: [
            { method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
            { method: "POST", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
          ],
        }
      : {}),
  });
}

/** The default-config component — unchanged import for `helipod.config.ts` files composing `auth`. */
export const auth = defineAuth();
