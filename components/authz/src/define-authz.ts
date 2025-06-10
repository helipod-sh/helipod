import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { authzSchema } from "./schema";
import type { AuthzConfig } from "./roles";
// authzContext + modules imported in Task 3
export function defineAuthz(config: AuthzConfig): ComponentDefinition {
  return defineComponent({
    name: "authz",
    requires: ["auth"],
    schema: authzSchema,
    modules: {},                 // Task 3: assignRole, revokeRole
    // context: (cctx) => authzContext(cctx, config),   // Task 3
    // contextType: { import: "@stackbase/authz", type: "AuthzContext" },  // Task 3
  });
}
