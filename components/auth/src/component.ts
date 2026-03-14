import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { authSchema } from "./schema";
import { makeAuthModules } from "./functions";
import { authContext } from "./context";
import { resolveAuthConfig, type AuthOptions } from "./config";

/**
 * `defineAuth(options?)` — the `@stackbase/auth` component: password + hardened session auth. The
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
    contextType: { import: "@stackbase/auth", type: "AuthContext" },
  });
}

/** The default-config component — unchanged import for `stackbase.config.ts` files composing `auth`. */
export const auth = defineAuth();
