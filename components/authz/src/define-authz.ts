import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { authzSchema } from "./schema";
import type { AuthzConfig } from "./roles";
import { authzContext } from "./context";
import { authzModules } from "./functions";
import { buildRuleAuth } from "./policies";
import { reconcileEffectivePermissions } from "./effective-permissions";

export function defineAuthz(config: AuthzConfig): ComponentDefinition {
  return defineComponent({
    name: "authz",
    requires: ["auth"],
    schema: authzSchema,
    modules: authzModules(config),
    context: (cctx) => authzContext(cctx, config),
    contextType: { import: "@stackbase/authz", type: "AuthzContext" },
    policies: config.policies,
    policyContext: async (cctx) => ({ auth: await buildRuleAuth(cctx) }),
    boot: (ctx) => reconcileEffectivePermissions(ctx, config),
  });
}
