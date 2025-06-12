import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { authzSchema } from "./schema";
import type { AuthzConfig } from "./roles";
import { authzContext } from "./context";
import { assignRole, revokeRole } from "./functions";

export function defineAuthz(config: AuthzConfig): ComponentDefinition {
  return defineComponent({
    name: "authz",
    requires: ["auth"],
    schema: authzSchema,
    modules: { assignRole, revokeRole },
    context: (cctx) => authzContext(cctx, config),
    contextType: { import: "@stackbase/authz", type: "AuthzContext" },
  });
}
