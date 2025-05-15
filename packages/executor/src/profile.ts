/**
 * Determinism profiles. Each UDF type runs under a frozen `UdfEnvironmentProfile` that
 * declares which capabilities the host grants the guest. Queries and mutations must be
 * deterministic (seeded RNG, no clock, no network) so the engine can re-run them for OCC
 * replay and reactive recomputation; actions are non-deterministic (native everything).
 *
 * NOTE: the inline executor (Tier 0, M5) ships these profiles as the contract and provides
 * a seeded RNG via the context. Hard global sandboxing (overriding `Math.random`,
 * `Date.now`, `fetch`) is the job of the V8-isolate executor (drop-in successor), where each
 * function has its own globals — see internals/05-udf-execution.md.
 */
export type UdfType = "query" | "mutation" | "action" | "httpAction";
export type CapabilityMode = "forbidden" | "seeded" | "native";

export interface UdfCapabilities {
  dbRead: boolean;
  dbWrite: boolean;
  random: CapabilityMode;
  clock: CapabilityMode;
  network: CapabilityMode;
}

export interface UdfEnvironmentProfile {
  udfType: UdfType;
  capabilities: UdfCapabilities;
}

export const QUERY_PROFILE: UdfEnvironmentProfile = Object.freeze({
  udfType: "query",
  capabilities: Object.freeze({ dbRead: true, dbWrite: false, random: "seeded", clock: "forbidden", network: "forbidden" }),
});

export const MUTATION_PROFILE: UdfEnvironmentProfile = Object.freeze({
  udfType: "mutation",
  capabilities: Object.freeze({ dbRead: true, dbWrite: true, random: "seeded", clock: "forbidden", network: "forbidden" }),
});

export const ACTION_PROFILE: UdfEnvironmentProfile = Object.freeze({
  udfType: "action",
  capabilities: Object.freeze({ dbRead: false, dbWrite: false, random: "native", clock: "native", network: "native" }),
});

export const HTTP_ACTION_PROFILE: UdfEnvironmentProfile = Object.freeze({
  udfType: "httpAction",
  capabilities: Object.freeze({ dbRead: false, dbWrite: false, random: "native", clock: "native", network: "native" }),
});

export function profileFor(type: UdfType): UdfEnvironmentProfile {
  switch (type) {
    case "query":
      return QUERY_PROFILE;
    case "mutation":
      return MUTATION_PROFILE;
    case "action":
      return ACTION_PROFILE;
    case "httpAction":
      return HTTP_ACTION_PROFILE;
  }
}
