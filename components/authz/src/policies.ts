import type { ComponentContext, RuleAuth } from "@stackbase/executor";

/** Re-exported so app authors can type their policies. */
export type { WhereInput, FieldOps, TablePolicy, PolicyPredicate } from "@stackbase/executor";

interface AuthFacade { getUserId(): Promise<string | null> }
interface AuthzFacade {
  can(p: string, s?: { type: string; id: string }): Promise<boolean>;
  roles(s?: { type: string; id: string }): Promise<string[]>;
  scopesWith(p: string, t?: string): Promise<string[]>;
}

/** Build the `auth` field of a row policy's rule-context from the composed auth+authz facades. */
export async function buildRuleAuth(cctx: ComponentContext): Promise<RuleAuth> {
  const authFacade = cctx.components.auth as AuthFacade | undefined;
  const authzFacade = cctx.components.authz as AuthzFacade;
  const userId = authFacade ? await authFacade.getUserId() : null;
  return {
    userId,
    identity: cctx.identity,
    can: (p, s) => authzFacade.can(p, s),
    roles: (s) => authzFacade.roles(s),
    scopesWith: (p, t) => authzFacade.scopesWith(p, t),
  };
}
