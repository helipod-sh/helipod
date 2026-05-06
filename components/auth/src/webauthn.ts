/**
 * WebAuthn/passkey seam (spec "Component surface" — `@simplewebauthn/server` is imported in
 * exactly ONE module, this one, mirroring the A3 `oauth.ts` pattern: one place to test, one place
 * a future library version bump touches). Every export here is a PURE function — no `ctx`, no
 * `db`, no scheduling — the ceremonies (T3/T4 `passkeys.ts`) own the db/challenge-storage/mint and
 * call these as plain data-in/data-out helpers, the same split A3's `signInWithIdToken` keeps
 * between jose/oauth4webapi calls and the mutation that persists identity.
 *
 * THIS IS THE ONLY PLACE WEBAUTHN CRYPTO VERIFICATION HAPPENS. A verification failure here must
 * always surface as either a thrown error or an explicit `{ verified: false }` — never a silent
 * accept. `verifyRegistrationResponse`/`verifyAuthenticationResponse` throw on a structural
 * mismatch (wrong challenge, wrong origin, wrong RP ID); they resolve `{ verified: false }` on a
 * cryptographic mismatch (bad signature). Both are "rejected" from the caller's point of view —
 * `passkeys.ts`'s finish* actions must treat `verified: false` exactly like a thrown error (a
 * single generic reject, per spec decision 4), never as a partial success.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type { PasskeyConfig } from "./config";

/** Base64url encode raw bytes (no padding) — the wire/storage shape for every credential-id /
 *  public-key / challenge field (rows are JSON, never raw bytes). */
export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Inverse of {@link b64u}. Throws on malformed input (never silently returns garbage bytes) — a
 *  caller feeding this a corrupt/foreign string gets a loud failure, not a mis-decoded key.
 *  `.slice()` both normalizes the return type to a plain (non-`Buffer`-backed) `Uint8Array` — the
 *  exact `Uint8Array_` shape `@simplewebauthn/server`'s types expect — and defensively copies out
 *  of the decoded `Buffer`'s backing memory. */
export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, "base64url")).slice();
}

/** A stored credential's verification material, in the schema's storage shape (base64url
 *  strings — see `passkeys` table doc comments in `schema.ts`). */
export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}

/** Deterministic WebAuthn `userID` bytes for a given app `userId` string. WebAuthn's `userID` is
 *  an opaque byte handle (never displayed, never a bearer secret) — round-tripping through
 *  `b64u`/`unb64u` keeps the ONE encoding convention this module uses for every byte<->string
 *  boundary rather than introducing a second bytes-from-string helper. */
function userIdBytes(userId: string): Uint8Array<ArrayBuffer> {
  return unb64u(b64u(new TextEncoder().encode(userId)));
}

/**
 * Build `generateRegistrationOptions()`'s options object for a `beginPasskeyRegistration` action.
 * `config.passkeys` supplies rpID/rpName/the resident-key + user-verification policy;
 * `attestationType: "none"` per spec decision 2 (no attestation-format/MDS verification in N1).
 * `existing` is the caller's already-registered credentials (`byUserId` index read) so the
 * authenticator can refuse to re-register one of them (`excludeCredentials`).
 */
export async function buildRegistrationOptions(
  config: PasskeyConfig,
  opts: {
    userId: string;
    userName: string;
    existing: Array<{ credentialId: string; transports?: string[] }>;
  },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: opts.userName,
    userID: userIdBytes(opts.userId),
    attestationType: "none",
    excludeCredentials: opts.existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: config.residentKey,
      userVerification: config.userVerification,
    },
  });
}

/** Normalized `verifyRegistrationResponse` result — the shape `_savePasskey` (T3) persists
 *  verbatim into the `passkeys` table. */
export interface VerifiedPasskeyRegistration {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  backedUp: boolean;
}

/**
 * Verify a registration attestation against a previously-issued, still-live challenge. Throws on
 * ANY mismatch (challenge/origin/RP-ID/structure) — `attestationType: "none"` means there is no
 * attestation signature to independently fail on, so those structural checks ARE the trust
 * boundary for registration; `verifyAuthentication` below is where the credential's own signature
 * is checked. Never returns a "kind of verified" result — either it returns the normalized
 * credential or it throws.
 */
export async function verifyRegistration(
  config: PasskeyConfig,
  opts: { response: RegistrationResponseJSON; expectedChallenge: string },
): Promise<VerifiedPasskeyRegistration> {
  const result = await verifyRegistrationResponse({
    response: opts.response,
    expectedChallenge: opts.expectedChallenge,
    expectedOrigin: config.origins,
    expectedRPID: config.rpID,
    requireUserVerification: config.userVerification === "required",
  });
  if (!result.verified || !result.registrationInfo) {
    // Defensive — `fmt: "none"` only ever resolves `verified: true` on success in the library
    // today, but a future library change (or a non-"none" attStmt sneaking through) must still
    // fail closed here rather than silently proceeding with an unverified credential.
    throw new Error("passkey registration verification failed");
  }
  const { credential, credentialBackedUp } = result.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: b64u(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    backedUp: credentialBackedUp,
  };
}

/**
 * Build `generateAuthenticationOptions()`'s options object for a `beginPasskeyAuthentication`
 * action. `allowCredentials: []` (or omitted) is exactly the usernameless/anti-enumeration shape
 * (spec decision 4) — this function does not itself decide that policy, it just passes through
 * whatever list the caller resolved (empty for unknown-email / usernameless, populated for a
 * known email).
 */
export async function buildAuthenticationOptions(
  config: PasskeyConfig,
  opts: { allowCredentials: Array<{ credentialId: string; transports?: string[] }> },
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: config.rpID,
    allowCredentials: opts.allowCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: config.userVerification,
  });
}

/** Result of verifying an authentication assertion. `newCounter` is the authenticator-reported
 *  signature counter the caller (`_finishPasskeyAuth`, T4) must persist atomically alongside the
 *  counter-regression check — this function does NOT write it anywhere. */
export interface VerifiedPasskeyAuthentication {
  verified: boolean;
  newCounter: number;
}

/**
 * Verify an authentication assertion against a previously-issued, still-live challenge and the
 * IMMUTABLE stored public key (decision: identity derives from the signature-verified assertion +
 * the stored `publicKey`; only `counter` is mutable, checked/updated elsewhere). Two distinct
 * failure shapes, both "rejected" from a caller's perspective:
 *   - Throws on a structural mismatch: wrong challenge, wrong origin, wrong RP ID, OR a counter
 *     that regressed/repeated a prior value (`@simplewebauthn/server` itself enforces spec
 *     decision 6's "0/0 accept, else require newCounter > storedCounter" rule inside
 *     `verifyAuthenticationResponse` — this seam does not duplicate that check, it relies on the
 *     library's and lets the throw propagate).
 *   - Resolves `{ verified: false, newCounter }` on a cryptographic mismatch: a signature that
 *     doesn't validate against the stored public key (a forged/tampered assertion).
 * `passkeys.ts` must treat BOTH as "do not mint, change no state" (spec decision 6/4).
 */
export async function verifyAuthentication(
  config: PasskeyConfig,
  opts: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: StoredCredential;
  },
): Promise<VerifiedPasskeyAuthentication> {
  const result = await verifyAuthenticationResponse({
    response: opts.response,
    expectedChallenge: opts.expectedChallenge,
    expectedOrigin: config.origins,
    expectedRPID: config.rpID,
    credential: {
      id: opts.credential.credentialId,
      publicKey: unb64u(opts.credential.publicKey),
      counter: opts.credential.counter,
      transports: opts.credential.transports as AuthenticatorTransportFuture[] | undefined,
    },
    requireUserVerification: config.userVerification === "required",
  });
  return { verified: result.verified, newCounter: result.authenticationInfo.newCounter };
}

/**
 * Decode a `clientDataJSON` (as sent by an authenticator, base64url) and return its `challenge`
 * field (itself base64url) — used by `finish*` actions to look up the stored `webauthnChallenge`
 * row `byChallenge` BEFORE calling `verifyRegistration`/`verifyAuthentication` (consume-before-
 * validate, spec decision 3). Defensive: any parse failure (malformed base64url, invalid JSON, or
 * a missing/non-string `challenge` field) returns `""` rather than throwing, so a garbled/foreign
 * client response falls through to the normal "no matching challenge row" generic-reject path
 * downstream instead of crashing the action.
 */
export function challengeOf(clientDataJSON: string): string {
  try {
    const decoded = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as unknown;
    if (decoded && typeof decoded === "object" && typeof (decoded as { challenge?: unknown }).challenge === "string") {
      return (decoded as { challenge: string }).challenge;
    }
    return "";
  } catch {
    return "";
  }
}
