import { action, mutation, query, type RegisteredFunction } from "@stackbase/executor";
import type { AuthConfig } from "./config";

/**
 * Passkey/WebAuthn module set (spec "Component surface"). `makeAuthModules` (functions.ts) calls
 * `makePasskeyModules(config)` whenever `defineAuth({ passkeys })` is configured (decision 12) —
 * absent `passkeys` ⇒ none of these eleven keys are registered, byte-identical to a pre-passkeys
 * deployment (`passkeys-config.test.ts` pins this).
 *
 * Task 1 (this file) only lands the registered-KEY contract with every body stubbed — no ceremony
 * logic yet. Task 3 fills `beginPasskeyRegistration`/`finishPasskeyRegistration` +
 * `_storeChallenge`/`_consumeChallenge`/`_savePasskey`; Task 4 fills
 * `beginPasskeyAuthentication`/`finishPasskeyAuthentication` + `_finishPasskeyAuth`; Task 5 fills
 * `listPasskeys`/`renamePasskey`/`revokePasskey`. The registered shape does not change across those
 * tasks — only these bodies do.
 */
const notImplemented = async (): Promise<never> => {
  throw new Error("not implemented");
};

export function makePasskeyModules(config: AuthConfig): Record<string, RegisteredFunction> {
  // `config` (the resolved `PasskeyConfig`) is unused until T3-T5 build the real ceremony bodies
  // over `config.passkeys`'s rpID/rpName/origins/TTLs — kept as a parameter now so the signature
  // (and every later task's diff) stays stable.
  void config;
  return {
    // Ceremony actions (client-callable over the sync connection) — every `@simplewebauthn/server`
    // call will live here (T2/T3/T4), never in a query/mutation.
    beginPasskeyRegistration: action(notImplemented),
    finishPasskeyRegistration: action(notImplemented),
    beginPasskeyAuthentication: action(notImplemented),
    finishPasskeyAuthentication: action(notImplemented),
    // Device management (client-callable, authed + ownership-checked — the A1 session-mgmt mirror).
    listPasskeys: query(notImplemented),
    renamePasskey: mutation(notImplemented),
    revokePasskey: mutation(notImplemented),
    // Internal mutations (not client-callable, `_`-prefixed, reachable from the actions above via
    // `runMutation` — the `scheduler:_enqueue` convention).
    _storeChallenge: mutation(notImplemented),
    _consumeChallenge: mutation(notImplemented),
    _savePasskey: mutation(notImplemented),
    _finishPasskeyAuth: mutation(notImplemented),
  };
}
