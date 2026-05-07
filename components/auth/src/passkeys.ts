import { action, mutation, query, commitThenThrow, type ActionCtx, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@stackbase/executor";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { AuthConfig } from "./config";
import { currentSessionOf, finishSignIn, normalizeEmail, type FacadeCtx, type MintResult, type MfaRequired } from "./functions";
import { buildRegistrationOptions, verifyRegistration, buildAuthenticationOptions, verifyAuthentication, challengeOf, type StoredCredential } from "./webauthn";
import { PasskeyLimitReachedError, PasskeyAlreadyRegisteredError } from "./errors";

/**
 * Passkey/WebAuthn module set (spec "Component surface"). `makeAuthModules` (functions.ts) calls
 * `makePasskeyModules(config)` whenever `defineAuth({ passkeys })` is configured (decision 12) —
 * absent `passkeys` ⇒ none of these eleven keys are registered, byte-identical to a pre-passkeys
 * deployment (`passkeys-config.test.ts` pins this).
 *
 * Task 3 (this file) fills the REGISTRATION ceremony: `beginPasskeyRegistration`/
 * `finishPasskeyRegistration` + the internal `_storeChallenge`/`_consumeChallenge`/`_savePasskey`
 * mutations, plus one new internal query (`_listPasskeyDescriptors`) the registration `begin` action
 * needs to resolve the caller + build `excludeCredentials` BEFORE any challenge exists to store.
 * Task 4 fills `beginPasskeyAuthentication`/`finishPasskeyAuthentication` + `_finishPasskeyAuth`;
 * Task 5 fills `listPasskeys`/`renamePasskey`/`revokePasskey`. The registered shape (which keys
 * exist) does not change across those tasks — only the still-stubbed bodies do.
 *
 * GLOBAL CONSTRAINT #1 (spec): every `@simplewebauthn/server` call lives in an ACTION — here,
 * `buildRegistrationOptions`/`verifyRegistration` (thin `webauthn.ts` wrappers over the library) are
 * called ONLY from `beginPasskeyRegistration`/`finishPasskeyRegistration`, never from a query/mutation.
 * The challenge row write, the per-user-limit/duplicate check, and the credential row write are all
 * internal MUTATIONS (`_storeChallenge`/`_consumeChallenge`/`_savePasskey`) — crypto stays out of the
 * transactor, exactly the A3 `signInWithIdToken`/jose split.
 */
const notImplemented = async (): Promise<never> => {
  throw new Error("not implemented");
};

/** Drop keys whose value is `undefined` — the syscall codec rejects `undefined` (same shape as
 *  `functions.ts`/`mfa/functions.ts`'s own `compact`, duplicated per-file by this codebase's
 *  existing convention). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** Every `finish*` challenge-consume/crypto failure surfaces as this ONE message (never distinguish
 *  wrong-challenge / wrong-origin / wrong-RP-ID / tampered-signature to the caller) — registration is
 *  authed so there's no cross-user enumeration surface (spec decision 5's "registration is authed"
 *  carve-out), but a granular error would still leak protocol-attack feedback to whoever is driving
 *  the ceremony, so it stays generic anyway. */
const REGISTRATION_FAILED = "passkey registration failed";
/** `_consumeChallenge`'s one generic outcome for a missing/wrong-kind/expired/replayed challenge row
 *  — shared by BOTH ceremonies (Task 4 reuses this same mutation for `kind: "authenticate"`). */
const CHALLENGE_INVALID = "invalid or expired passkey challenge";
/** Task 4's ONE generic outcome for every `finishPasskeyAuthentication` failure mode — a stale/
 *  replayed/wrong-kind challenge, an unknown `credentialId`, a `userHandle` that doesn't match the
 *  stored credential's owner, a structurally-invalid or cryptographically-unverified assertion, AND
 *  a signature-counter regression (spec decision 6/"generic reject, mint nothing, change no state").
 *  Never distinguish these to the caller — that distinction is exactly the anti-enumeration/clone-
 *  detection-oracle surface decision 5/6 close off. */
const AUTHENTICATION_FAILED = "passkey authentication failed";

/** A caller's existing credentials, shaped for `buildRegistrationOptions`'s `excludeCredentials`. */
interface PasskeyDescriptor {
  credentialId: string;
  transports?: string[];
}

/**
 * Internal query (Task 3): resolve the AMBIENT authenticated caller (decision 9 — registration
 * requires an authed session, anonymous included; unauthenticated ⇒ generic reject) and return just
 * enough for `beginPasskeyRegistration` to build `generateRegistrationOptions`' input BEFORE any
 * challenge exists to persist: the `userId` (WebAuthn `userID` bytes derive from this), a display
 * `userName` (the account email, falling back to the opaque userId — the exact `startMfaEnrollment`
 * `accountName` convention), and the caller's own already-registered credentials as `excludeCredentials`
 * (so the same authenticator can't double-register — spec decision 9). A pure read — no crypto, no
 * write — kept separate from `_storeChallenge` so `beginPasskeyRegistration` stays a true action:
 * resolve-caller (this query) → build options (the action, calling into `webauthn.ts`) → persist the
 * challenge `_storeChallenge` re-resolves the caller independently, at write time).
 */
function _listPasskeyDescriptors() {
  return query(async (ctx: QueryCtx): Promise<{ userId: string; userName: string; existing: PasskeyDescriptor[] }> => {
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (!current) throw new Error("not authenticated");
    const userId = current.userId as string;
    const user = await ctx.db.get(userId);
    const userName = (user?.email as string | undefined) ?? userId;
    const rows = await ctx.db.query("passkeys", "byUserId").eq("userId", userId).collect();
    const existing = rows.map((r) =>
      compact({ credentialId: r.credentialId as string, transports: r.transports as string[] | undefined }),
    );
    return { userId, userName, existing };
  });
}

/**
 * `_storeChallenge` (Task 3 body; Task 4 will call this same mutation for `kind: "authenticate"`).
 * For `kind: "register"`: resolve the ambient session INDEPENDENTLY of any value threaded from an
 * earlier call (defense in depth — the write is gated on a FRESH auth check at the moment the
 * ceremony's challenge row is actually created, not on trust in an argument) and reject generically
 * if unauthenticated; the resolved `userId` is what the row (and its returned value) is bound to.
 * For `kind: "authenticate"` there is no ambient-auth requirement (a signed-out visitor is exactly
 * who calls this) — `userId` stays undefined unless a future authenticate-kind caller passes one
 * (Task 4's email-scoped begin does not, per plan: the row is unscoped either way, matching the
 * anti-enumeration shape). Single-use TTL row, `compact()` at the codec boundary.
 */
function _storeChallenge(config: AuthConfig) {
  return mutation(async (ctx: MutationCtx, { kind, challenge }: { kind: "register" | "authenticate"; challenge: string }): Promise<{ userId?: string }> => {
    const passkeyConfig = config.passkeys!;
    let userId: string | undefined;
    if (kind === "register") {
      const current = await currentSessionOf(ctx as unknown as FacadeCtx);
      if (!current) throw new Error("not authenticated"); // decision 9 — registration requires an authed caller
      userId = current.userId as string;
    }
    const now = ctx.now();
    await ctx.db.insert(
      "webauthnChallenge",
      compact({ challenge, kind, userId, expiresAt: now + passkeyConfig.challengeTtlMs, createdAt: now }),
    );
    return compact({ userId });
  });
}

/**
 * `_consumeChallenge` — consume-BEFORE-validate (spec decision 3/global constraint): look the
 * challenge up `byChallenge`, DELETE it first (single-use, single-winner under single-writer OCC —
 * a replay finds no row), THEN validate `kind` + `expiresAt`. Any post-delete failure returns
 * `commitThenThrow` so the delete still commits (the `_consumeOAuthState`/`completeMfaSignIn`
 * pattern) rather than a plain throw, which would roll the whole transaction — including the
 * consume — back and let the same challenge be retried. A miss (nothing to consume) is a plain
 * throw: nothing was staged, so there is nothing to lose by rolling back.
 */
function _consumeChallenge() {
  return mutation(async (
    ctx: MutationCtx,
    { challenge, kind }: { challenge: string; kind: "register" | "authenticate" },
  ): Promise<{ userId?: string } | ReturnType<typeof commitThenThrow>> => {
    const [row] = await ctx.db.query("webauthnChallenge", "byChallenge").eq("challenge", challenge).collect();
    if (!row) throw new Error(CHALLENGE_INVALID); // nothing consumed — no matching/already-replayed challenge
    await ctx.db.delete(row._id as string); // consume FIRST
    if ((row.kind as string) !== kind || ctx.now() > (row.expiresAt as number)) return commitThenThrow(CHALLENGE_INVALID);
    return compact({ userId: row.userId as string | undefined });
  });
}

/**
 * `_savePasskey` — the credential write (Task 3 body). Enforces the per-user limit
 * (`maxCredentialsPerUser`, `byUserId` range — never a table scan) and the duplicate-`credentialId`
 * guard (`byCredentialId` equality; uniqueness relies on single-writer OCC serialization, same note
 * `accounts`/`schema.ts` carries). Both throw TYPED errors (not the ceremony's generic message) —
 * these are authed, caller-actionable ("you already registered this key" / "you're at your limit"),
 * not an anti-enumeration surface (decision 5 — registration is authed, no enumeration concern).
 */
function _savePasskey(config: AuthConfig) {
  return mutation(async (
    ctx: MutationCtx,
    args: {
      userId: string;
      credentialId: string;
      publicKey: string;
      counter: number;
      transports?: string[];
      backedUp?: boolean;
      deviceName?: string;
    },
  ): Promise<{ passkeyId: string }> => {
    const passkeyConfig = config.passkeys!;
    const existingForUser = await ctx.db.query("passkeys", "byUserId").eq("userId", args.userId).collect();
    if (existingForUser.length >= passkeyConfig.maxCredentialsPerUser) throw new PasskeyLimitReachedError();

    const dup = await ctx.db.query("passkeys", "byCredentialId").eq("credentialId", args.credentialId).collect();
    if (dup.length > 0) throw new PasskeyAlreadyRegisteredError();

    const passkeyId = await ctx.db.insert(
      "passkeys",
      compact({
        userId: args.userId,
        credentialId: args.credentialId,
        publicKey: args.publicKey,
        counter: args.counter,
        transports: args.transports,
        backedUp: args.backedUp,
        deviceName: args.deviceName,
        createdAt: ctx.now(),
      }),
    );
    return { passkeyId: passkeyId as string };
  });
}

/**
 * `beginPasskeyRegistration({ deviceName? })` — ACTION (Task 3). `deviceName` is accepted for API
 * shape parity with `finishPasskeyRegistration` (spec "The two ceremonies") but unused here — it is
 * only ever persisted by `finish*`'s `_savePasskey` call, never stored on the ephemeral challenge
 * row. Sequence (spec "Registration"): resolve the caller + existing credentials
 * (`_listPasskeyDescriptors` — an unauthenticated caller is rejected generically right here, before
 * any crypto runs), build the registration options (`webauthn.ts`'s `buildRegistrationOptions`,
 * which is what actually generates the random `challenge`), THEN persist that challenge
 * (`_storeChallenge`). Returns the options JSON verbatim to the client.
 */
function beginPasskeyRegistration(config: AuthConfig) {
  return action(async (ctx, _args?: { deviceName?: string }) => {
    const passkeyConfig = config.passkeys!;
    const actionCtx = ctx as ActionCtx;

    const caller = await actionCtx.runQuery<{ userId: string; userName: string; existing: PasskeyDescriptor[] }>(
      "auth:_listPasskeyDescriptors",
      {},
    );
    const options = await buildRegistrationOptions(passkeyConfig, {
      userId: caller.userId,
      userName: caller.userName,
      existing: caller.existing,
    });
    // Persist the challenge `generateRegistrationOptions` just generated. `_storeChallenge`
    // re-resolves the caller from the ambient session itself (defense in depth) rather than trusting
    // `caller.userId` threaded from the query above.
    await actionCtx.runMutation("auth:_storeChallenge", { kind: "register", challenge: options.challenge });
    return options;
  });
}

/**
 * `finishPasskeyRegistration({ response, deviceName? })` — ACTION (Task 3). Decodes the challenge out
 * of the attestation's `clientDataJSON` (`webauthn.ts`'s `challengeOf` — NOT trusted input from the
 * client beyond "which row to look up"), consumes the matching `webauthnChallenge` row
 * (consume-before-validate; a missing/wrong-kind/expired/replayed challenge is one generic reject and
 * `_consumeChallenge`'s delete has already committed regardless), verifies the attestation
 * (`webauthn.ts`'s `verifyRegistration` — throws on ANY structural mismatch: wrong challenge/origin/
 * RP-ID), then delegates the write to `_savePasskey` (per-user limit + duplicate guard, its own typed
 * errors — NOT folded into the generic message, since those are authed/actionable, not an
 * enumeration surface). Returns `{ registered: true, passkeyId }`.
 */
function finishPasskeyRegistration(config: AuthConfig) {
  return action(async (ctx, { response, deviceName }: { response: RegistrationResponseJSON; deviceName?: string }) => {
    const passkeyConfig = config.passkeys!;
    const actionCtx = ctx as ActionCtx;

    const challenge = challengeOf(response.response.clientDataJSON);
    let consumed: { userId?: string };
    try {
      consumed = await actionCtx.runMutation<{ userId?: string }>("auth:_consumeChallenge", {
        challenge,
        kind: "register",
      });
    } catch {
      throw new Error(REGISTRATION_FAILED);
    }
    // Defensive: a "register"-kind challenge row is ALWAYS written with a userId by `_storeChallenge`
    // (it rejects unauthenticated before ever inserting) — this can only be hit if a future bug lets
    // a userId-less row through, and even then it must fail closed, never mint/save headless.
    if (!consumed.userId) throw new Error(REGISTRATION_FAILED);

    let credential;
    try {
      credential = await verifyRegistration(passkeyConfig, { response, expectedChallenge: challenge });
    } catch {
      throw new Error(REGISTRATION_FAILED);
    }

    // `compact()` at the wire boundary: `transports`/`deviceName` may be `undefined` here, and the
    // syscall codec (`jsonToConvex`/`convexToJson`) rejects a literal `undefined` value in the args
    // object crossing `runMutation` — omit rather than null it out (same rule the DB-insert side of
    // `_savePasskey` itself already applies).
    const saved = await actionCtx.runMutation<{ passkeyId: string }>(
      "auth:_savePasskey",
      compact({
        userId: consumed.userId,
        credentialId: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports,
        backedUp: credential.backedUp,
        deviceName,
      }),
    );
    return { registered: true as const, passkeyId: saved.passkeyId };
  });
}

// ---------------------------------------------------------------------------------------------
// Task 4 — authentication ceremony (assertion) + clone detection + mint.
// ---------------------------------------------------------------------------------------------

/**
 * Internal query (Task 4): resolve `allowCredentials` for a NON-DISCOVERABLE
 * `beginPasskeyAuthentication({ email })`. Anti-enumeration (spec decision 5): an unknown email (no
 * `users` row) or a known user with zero passkeys both return `[]` — byte-shape-identical to the
 * usernameless/discoverable begin, so `begin` is never usable as an existence oracle. `byEmail`/
 * `byUserId` index reads only — never a table scan.
 */
function _listCredentialsForEmail() {
  return query(async (ctx: QueryCtx, { email }: { email: string }): Promise<PasskeyDescriptor[]> => {
    const [user] = await ctx.db.query("users", "byEmail").eq("email", normalizeEmail(email)).collect();
    if (!user) return [];
    const rows = await ctx.db.query("passkeys", "byUserId").eq("userId", user._id as string).collect();
    return rows.map((r) =>
      compact({ credentialId: r.credentialId as string, transports: r.transports as string[] | undefined }),
    );
  });
}

/** A stored credential's verification material PLUS its owning `userId` — what
 *  `finishPasskeyAuthentication` needs to call `webauthn.ts`'s `verifyAuthentication` and to
 *  cross-check `response.userHandle`. `_getPasskeyByCredentialId`'s return shape. */
interface StoredCredentialWithOwner extends StoredCredential {
  userId: string;
}

/**
 * Internal query (Task 4): look up a `passkeys` row by `credentialId` (the `response.id` an
 * authenticator's assertion carries) — `byCredentialId` equality, never a table scan. Returns `null`
 * on a miss (an unregistered/foreign credential); `finishPasskeyAuthentication` turns that into the
 * ONE generic `AUTHENTICATION_FAILED` reject, same as every other failure mode here.
 */
function _getPasskeyByCredentialId() {
  return query(async (ctx: QueryCtx, { credentialId }: { credentialId: string }): Promise<StoredCredentialWithOwner | null> => {
    const [row] = await ctx.db.query("passkeys", "byCredentialId").eq("credentialId", credentialId).collect();
    if (!row) return null;
    return compact({
      userId: row.userId as string,
      credentialId: row.credentialId as string,
      publicKey: row.publicKey as string,
      counter: row.counter as number,
      transports: row.transports as string[] | undefined,
    });
  });
}

/**
 * `beginPasskeyAuthentication({ email? })` — ACTION (Task 4). **Discoverable/usernameless** (no
 * `email`): `allowCredentials: []`, the authenticator resolves a resident credential itself and
 * reports the owning `userId` back via `response.userHandle` at finish. **Non-discoverable**
 * (`email` given): resolve that user's credential ids via `_listCredentialsForEmail` — which already
 * returns `[]` for an unknown email (anti-enumeration, decision 5), so this action never has to
 * branch on "did we find a user." Either way: build the options (`webauthn.ts`'s
 * `buildAuthenticationOptions`, which generates the random `challenge`), THEN persist that challenge
 * (`_storeChallenge`, `kind: "authenticate"` — unscoped to any `userId`, matching the usernameless
 * shape regardless of which path produced `allowCredentials`). Returns the options JSON verbatim.
 */
function beginPasskeyAuthentication(config: AuthConfig) {
  return action(async (ctx, args?: { email?: string }) => {
    const passkeyConfig = config.passkeys!;
    const actionCtx = ctx as ActionCtx;

    const allowCredentials = args?.email
      ? await actionCtx.runQuery<PasskeyDescriptor[]>("auth:_listCredentialsForEmail", { email: args.email })
      : [];
    const options = await buildAuthenticationOptions(passkeyConfig, { allowCredentials });
    await actionCtx.runMutation("auth:_storeChallenge", { kind: "authenticate", challenge: options.challenge });
    return options;
  });
}

/**
 * `_finishPasskeyAuth` — the ATOMIC counter-check + mint (Task 4, spec decision 6). Re-reads the
 * `passkeys` row `byCredentialId` INDEPENDENTLY of whatever `finishPasskeyAuthentication` read a
 * moment earlier via `runQuery` (defense in depth against a TOCTOU race under concurrent sign-ins —
 * the whole point of doing the clone-detection compare-and-set INSIDE this single-writer-OCC
 * transaction rather than trusting a value read outside it): missing row → generic reject (a
 * credential deleted/revoked between `finishPasskeyAuthentication`'s lookup and this mutation).
 * Clone rule: `stored === 0 && newCounter === 0` (an authenticator that doesn't report counters —
 * true of essentially all synced/multi-device passkeys) → accept; else `newCounter > stored` →
 * accept; else — a regression or repeat of a nonzero value, a possible cloned authenticator —
 * **generic reject, NO write, NO mint** (no auto-revoke/DoS blast radius, per decision 6). On
 * accept: advance `counter`, stamp `lastUsedAt`, THEN finish sign-in through `finishSignIn` — passkey
 * auth still bypasses `requireEmailVerification` by construction (possession of the registered
 * credential IS proof), but it is a FIRST factor like every other sign-in, so it goes through the
 * same MFA gate: `finishSignIn` mints directly for a non-MFA user, or returns `{ mfaRequired }` when
 * the user has a confirmed TOTP enrollment.
 *
 * SECURITY (corrected vs the parallel-designed spec's decision 7): passkeys and MFA were designed
 * concurrently, so decision 7's "mint unconditionally like every other flow" predates MFA's
 * `finishSignIn` gate (built + merged after). Minting DIRECTLY here would let a user enrolled in
 * both password+TOTP AND a passkey skip TOTP entirely via a passkey sign-in — silently defeating
 * their explicitly-configured second factor. Routing through `finishSignIn` (the same interposition
 * every other first-factor path uses) closes that: an enrolled second factor is never bypassed. A
 * future "passkey-with-user-verification satisfies MFA" refinement (skip TOTP when the assertion's
 * UV flag is set) is a deliberate follow-on, not this conservative default.
 */
function _finishPasskeyAuth(config: AuthConfig) {
  return mutation(async (
    ctx: MutationCtx,
    { credentialId, newCounter, deviceLabel }: { credentialId: string; newCounter: number; deviceLabel?: string },
  ): Promise<MintResult | MfaRequired> => {
    const [row] = await ctx.db.query("passkeys", "byCredentialId").eq("credentialId", credentialId).collect();
    if (!row) throw new Error(AUTHENTICATION_FAILED); // credential vanished between lookup and mint — fail closed

    const stored = row.counter as number;
    const isFreshAuthenticator = stored === 0 && newCounter === 0; // no counter support — accept (decision 6)
    const advanced = newCounter > stored;
    if (!isFreshAuthenticator && !advanced) {
      // Regression or repeat of a nonzero counter — a possible cloned authenticator. Reject
      // generically; change NOTHING (no counter write, no mint, no auto-revoke).
      throw new Error(AUTHENTICATION_FAILED);
    }

    await ctx.db.replace(row._id as string, { ...row, counter: newCounter, lastUsedAt: ctx.now() });
    return finishSignIn(ctx, config, row.userId as string, deviceLabel);
  });
}

/**
 * `finishPasskeyAuthentication({ response, deviceLabel? })` — ACTION (Task 4). Decodes the challenge
 * out of the assertion's `clientDataJSON` (`webauthn.ts`'s `challengeOf`), consumes the matching
 * `webauthnChallenge` row (consume-before-validate — `_consumeChallenge`, `kind: "authenticate"`;
 * already built in Task 3 to be kind-agnostic), looks up the credential `byCredentialId`
 * (`_getPasskeyByCredentialId` — an unknown credential is a generic reject, same shape as every
 * other failure here), cross-checks `response.userHandle` against the credential's OWNER `userId`
 * when the authenticator supplied one (usernameless/discoverable sign-in always does; a
 * non-discoverable one may omit it), then verifies the assertion (`webauthn.ts`'s
 * `verifyAuthentication` — against the IMMUTABLE stored `publicKey`, so there is no TOCTOU on
 * identity; only the mutable `counter` needs the atomic re-check `_finishPasskeyAuth` performs).
 * Delegates the counter-check + mint to `_finishPasskeyAuth`. Every failure mode collapses to the
 * ONE `AUTHENTICATION_FAILED` message (spec decision 5) — a stale/replayed challenge, an unknown
 * credential, a `userHandle` mismatch, a failed/unverified assertion, and a counter-regression
 * reject (raised by `_finishPasskeyAuth` itself) are all indistinguishable to the caller.
 */
function finishPasskeyAuthentication(config: AuthConfig) {
  return action(async (
    ctx,
    { response, deviceLabel }: { response: AuthenticationResponseJSON; deviceLabel?: string },
  ): Promise<MintResult | MfaRequired> => {
    const passkeyConfig = config.passkeys!;
    const actionCtx = ctx as ActionCtx;

    const challenge = challengeOf(response.response.clientDataJSON);
    try {
      await actionCtx.runMutation("auth:_consumeChallenge", { challenge, kind: "authenticate" });
    } catch {
      throw new Error(AUTHENTICATION_FAILED);
    }

    const stored = await actionCtx.runQuery<StoredCredentialWithOwner | null>("auth:_getPasskeyByCredentialId", {
      credentialId: response.id,
    });
    if (!stored) throw new Error(AUTHENTICATION_FAILED); // unknown/foreign credentialId

    // `response.userHandle` is the WebAuthn `userID` bytes we minted at registration
    // (`webauthn.ts`'s `userIdBytes` — UTF-8 of the app `userId`, base64url'd). A discoverable/
    // usernameless assertion always carries it; a non-discoverable one MAY omit it — only check
    // when present, but a MISMATCH (an authenticator claiming a different owner than the credential
    // it signed with actually has) is a generic reject, never a partial trust.
    const userHandle = response.response.userHandle;
    if (userHandle !== undefined) {
      const claimedUserId = Buffer.from(userHandle, "base64url").toString("utf8");
      if (claimedUserId !== stored.userId) throw new Error(AUTHENTICATION_FAILED);
    }

    let verified;
    try {
      verified = await verifyAuthentication(passkeyConfig, {
        response,
        expectedChallenge: challenge,
        credential: {
          credentialId: stored.credentialId,
          publicKey: stored.publicKey,
          counter: stored.counter,
          transports: stored.transports,
        },
      });
    } catch {
      throw new Error(AUTHENTICATION_FAILED);
    }
    if (!verified.verified) throw new Error(AUTHENTICATION_FAILED);

    // `_finishPasskeyAuth` re-reads the row and applies the atomic clone-detection compare-and-set
    // (decision 6) INDEPENDENTLY of `stored.counter` above — this action's own verify call already
    // ran the library's own counter check against the (possibly slightly stale) value fetched by
    // `_getPasskeyByCredentialId`, but the mint transaction is the source of truth under concurrency.
    return actionCtx.runMutation<MintResult | MfaRequired>(
      "auth:_finishPasskeyAuth",
      compact({ credentialId: stored.credentialId, newCounter: verified.newCounter, deviceLabel }),
    );
  });
}

export function makePasskeyModules(config: AuthConfig): Record<string, RegisteredFunction> {
  return {
    // Ceremony actions (client-callable over the sync connection) — every `@simplewebauthn/server`
    // call lives here (T3 registration, T4 authentication), never in a query/mutation.
    beginPasskeyRegistration: beginPasskeyRegistration(config),
    finishPasskeyRegistration: finishPasskeyRegistration(config),
    beginPasskeyAuthentication: beginPasskeyAuthentication(config),
    finishPasskeyAuthentication: finishPasskeyAuthentication(config),
    // Device management (client-callable, authed + ownership-checked — the A1 session-mgmt mirror).
    listPasskeys: query(notImplemented), // T5
    renamePasskey: mutation(notImplemented), // T5
    revokePasskey: mutation(notImplemented), // T5
    // Internal mutations/queries (not client-callable, `_`-prefixed, reachable from the actions above
    // via `runMutation`/`runQuery` — the `scheduler:_enqueue` convention).
    _storeChallenge: _storeChallenge(config),
    _consumeChallenge: _consumeChallenge(),
    _savePasskey: _savePasskey(config),
    _finishPasskeyAuth: _finishPasskeyAuth(config),
    _listPasskeyDescriptors: _listPasskeyDescriptors(),
    _listCredentialsForEmail: _listCredentialsForEmail(),
    _getPasskeyByCredentialId: _getPasskeyByCredentialId(),
  };
}
