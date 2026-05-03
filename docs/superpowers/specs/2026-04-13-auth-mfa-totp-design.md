# Auth slice A4 — MFA / TOTP two-factor (design)

**Date:** 2026-04-13
**Status:** Proposed (design spec — awaiting approval before implementation)
**Arc context:** A follow-on to the three-slice core auth arc — A1 session core (SHIPPED
`4fd0ac1`: hashed access+refresh pairs, rotation/reuse detection, device management,
anonymous, the `mintSession` chokepoint), A2 email flows (SHIPPED `e0b595f`:
verification/reset/magic-link/OTP on the `authCodes` hashed-code model), A3 external
identity (SHIPPED `0d2ff7c`: social OAuth + third-party JWT/OIDC, the
`oauthHandoff` "mint-authorization holds no token" pattern, the
`ComponentDefinition.httpRoutes` seam), plus the "more providers" follow-on (SHIPPED
`4553dc6`). This slice adds a **second factor** on top of a satisfied first factor. It
mints through A1's `mintSession` unchanged and reuses A2's hashed-at-rest code discipline
for recovery codes, but introduces one genuinely new concern the earlier slices never had:
a **recoverable** secret at rest (the TOTP shared secret), which forces at-rest
**encryption**, not one-way hashing.

**Goal:** Give `@stackbase/auth` TOTP-based two-factor authentication (RFC 6238) with
one-time recovery codes as the backup factor: enroll an authenticator app, gate every
first-factor sign-in behind a valid TOTP (or recovery code) when the user has confirmed
MFA, and let the user disable / reset / regenerate — all without ever bypassing the A1
`mintSession` chokepoint, and with the shared secret encrypted at rest under a
deployment-controlled key.

## Locked design decisions

1. **TOTP per RFC 6238, hand-rolled on `node:crypto` — no `otplib` dependency.** TOTP is
   small and fully expressible with primitives already in the tree: HMAC-SHA1 over an
   8-byte big-endian time counter (`node:crypto.createHmac`), RFC 4226 dynamic truncation,
   and an RFC 4648 base32 codec (~60 lines total, `mfa/totp.ts`). This matches the
   codebase's zero-dependency posture (`resendEmail` is "one fetch, zero dependencies";
   `crypto.ts` uses only `node:crypto` + `hash-wasm`). `otplib` would add a supply-chain
   surface and bundles HOTP/authenticator/counter machinery we do not need. Defaults —
   **SHA1 / 6 digits / 30s period** — are the only combination Google Authenticator and
   the broad authenticator-app ecosystem reliably support; `algorithm`/`digits`/`period`
   are stored per enrollment for forward-compat but are not surfaced as app knobs in v1.

2. **The TOTP shared secret is ENCRYPTED at rest, not hashed — the central new concern.**
   Unlike every A1/A2 secret (session tokens, OTP/magic/reset codes — all SHA-256-hashed,
   because verification only ever *compares*), a TOTP secret must be **recovered** on every
   verification to re-derive the expected code, so a one-way hash is impossible. It is
   encrypted with **AES-256-GCM** (`node:crypto.createCipheriv`) under a
   deployment-provided 32-byte key. This is a deliberate, documented escalation of the A3
   "recoverable-secret exception" already granted to `oauthState.codeVerifier`/`nonce` —
   but where those are single-use, ~10-minute, server-only transaction secrets, the TOTP
   secret is **long-lived and high-value**, so plaintext-at-rest (the `codeVerifier`
   posture) is explicitly rejected here in favor of authenticated encryption.

3. **Encryption-key management: a deployment keyring, AAD-bound, versioned envelope,
   rotation-ready, fail-fast.**
   - The key is supplied through config — `defineAuth({ mfa: { encryptionKey } })` or a
     keyring `{ mfa: { encryptionKeys: [{ id, key }, …] } }` — sourced by the app from an
     env var (`process.env.STACKBASE_AUTH_MFA_KEY`), the same "secret comes from the
     environment, config is code" shape as `STACKBASE_ADMIN_KEY`. A key is a 32-byte value
     given as base64 or hex; a wrong-length or empty key **fails fast at
     `resolveAuthConfig`** (the `oauth.redirectAllowlist` precedent — configuring `mfa`
     without a usable key is a config error, not a runtime surprise).
   - **Stored envelope:** `v1.<keyId>.<iv>.<ciphertext>.<tag>` (all base64url). The `keyId`
     names which keyring entry encrypted it; the 96-bit `iv` is random per encryption; the
     128-bit GCM `tag` authenticates.
   - **AAD = the enrollment's `userId`.** The Additional Authenticated Data binds a
     ciphertext to its owner, so a stolen/DB-swapped ciphertext cannot be transplanted onto
     another user's row and still decrypt.
   - **Rotation:** the keyring's **first** entry is the primary (used for all new
     encryptions); decryption dispatches on the stored `keyId`, so old secrets keep
     decrypting under retired keys until the user re-enrolls. Rotating = prepend a new
     primary; drop a retired key only once no confirmed enrollment references its `keyId`.
   - **Loss posture (documented, not defended):** losing every keyring entry renders all
     stored TOTP secrets permanently undecryptable — the by-design fallback is recovery
     codes, then re-enrollment. This is the same "the key is the deployment's
     responsibility" contract as `STACKBASE_ADMIN_KEY` for storage capability tokens.

4. **Two-phase enrollment: generate → prove-a-live-code → activate.**
   `startMfaEnrollment` generates a fresh secret, stores it **encrypted but unconfirmed**
   (`confirmedAt` absent), and returns the raw base32 secret + an `otpauth://` URI (for QR
   rendering) to the caller **once** — the A2 precedent of "the raw secret is returned to
   the caller from inside the mutation, never persisted in the clear" (`mintSession` returns
   raw tokens; `_issueCode` returns the raw code). `confirmMfaEnrollment(code)` decrypts,
   verifies a live TOTP, sets `confirmedAt`, and **only then** generates the recovery-code
   set. An unconfirmed enrollment is inert: it never gates sign-in and is overwritten by a
   subsequent `startMfaEnrollment`. This proves the user's authenticator is correctly
   configured before MFA can ever lock them out.

5. **The second-factor gate is a `mintSession` WRAPPER, never a bypass — one chokepoint,
   `finishSignIn`.** A1's invariant is "every sign-in mints through `mintSession`." This
   slice preserves it by interposing **one** helper, `finishSignIn(ctx, config, userId,
   deviceLabel?)`, that every first-factor success path calls **instead of** calling
   `mintSession` directly:
   - if the user has a **confirmed** MFA enrollment → do **not** mint. Insert a short-lived
     **MFA challenge** row (holds NO session token), and return
     `{ mfaRequired: true, pendingToken, expiresAt }`;
   - otherwise → `return mintSession(...)`, byte-identical to today.

   `mintSession` itself is **unchanged and still the only mint**. The **only** new direct
   caller of `mintSession` is `completeMfaSignIn` — the terminal step that runs *after* a
   second factor has verified. So for an MFA-enrolled user, the sole path to a real session
   is `finishSignIn` → challenge → `completeMfaSignIn` → `mintSession`. There is no code
   path where a first factor alone reaches `mintSession` for an enrolled user.

6. **The MFA-pending state is a hashed, single-use, short-TTL challenge ROW — the
   `oauthHandoff` shape, plus an attempt counter.** `mfaChallenges { challengeHash, userId,
   deviceLabel?, failedAttempts, expiresAt, createdAt }`. `finishSignIn` mints a raw
   `pendingToken` (`generateToken()`), stores only `sha256base64url(pendingToken)`, returns
   the raw token. The pending token is **not** a session token and grants nothing but the
   right to attempt the second factor for one user, once, within `challengeTtlMs` (default
   5 min). `completeMfaSignIn` is **consume-before-validate** exactly like A3's
   `_consumeHandoff`: look up by hash, then verify the factor; success deletes the row and
   `mintSession`s; the attempt counter (below) governs failure.

7. **Recovery codes: one-time, hashed-at-rest, separate rows — the A2 `authCodes`
   discipline.** `confirmMfaEnrollment` (and `regenerateRecoveryCodes`) generate
   `recoveryCodeCount` (default 10) high-entropy codes, return them raw to the caller
   **once**, and store only `sha256base64url` hashes in `mfaRecoveryCodes { userId,
   codeHash, createdAt }` (one row per code, so each is independently consume-before-validate
   under single-writer OCC). A recovery code is consumed by **deleting** its row.
   Regenerating replaces the whole set (delete all `byUserId`, insert the new ones).
   `getMfaStatus` surfaces `recoveryCodesRemaining` so the client can nudge on low count.

8. **`completeMfaSignIn` accepts a TOTP code OR a recovery code through one `code` param.**
   Verify order: try TOTP against the decrypted secret (±window); on no match, try the
   presented value as a recovery code (hash-lookup by `["userId","codeHash"]`). A TOTP match
   advances replay state (decision 9); a recovery match deletes the code row. This is one
   input box for the user with no ambiguity server-side (a 6-digit TOTP and a
   high-entropy recovery code do not collide in practice, and each match path consumes only
   its own artifact).

9. **TOTP replay protection: a monotonic `lastUsedStep`.** RFC 6238 verification accepts a
   ±`window` step tolerance (default **±1**, i.e. the current 30s step plus one on each side,
   covering clock skew). To stop the same code being replayed inside its validity window,
   the enrollment row records `lastUsedStep` (the time-counter of the last accepted code);
   a presented code whose matched step `<= lastUsedStep` is **rejected**, and a success
   advances `lastUsedStep` to the matched step. This is the RFC's own resynchronization/
   replay guidance made concrete.

10. **Second-factor rate-limiting rides the challenge row's own counter.** `mfaAttempts`
    (default **5**) wrong second-factor attempts against a single challenge **delete** the
    challenge row (via `commitThenThrow`, the A1/A2 lockout mechanism — the counter/delete
    commits even though the call throws), forcing the user to restart the first factor.
    This bounds guessing to `mfaAttempts` per pending window with no transport identifiers
    (carried forward from A1/A2 by design), and needs no global counter because the pending
    token itself is unguessable and single-purpose.

11. **Disable / regenerate require a FRESH second factor (re-auth), not just a session.**
    `disableMfa(code)` and `regenerateRecoveryCodes(code)` require the caller to be
    authenticated (`ctx.auth.getUserId()`) **and** to present a currently-valid TOTP or
    recovery code — possession, proven now, of the factor being changed. `disableMfa`
    deletes the enrollment **and** all `mfaRecoveryCodes` rows for the user. This blocks a
    stolen-but-still-live access token from silently stripping the victim's second factor.
    (Password reset is separately handled — decision 12.)

12. **Every mint-shaped success path is gated, including credential-boundary re-mints.**
    `finishSignIn` replaces the direct `mintSession` call in: password `signIn`,
    `signUp` (post-verification mint), `verifyEmail`, `signInWithMagicLink`,
    `signInWithOtp`, `resetPassword`, and A3's `_resolveExternalIdentity` (`outcome:"mint"`)
    / `_consumeHandoff`. **Rationale for the sharp edges:** a password *reset* proves
    mailbox control but **not** the second factor, so a reset of an MFA-enrolled account
    still challenges (recovery codes are the escape if the authenticator is also lost) —
    this is intentional and documented. `refresh` and `signInAnonymously` are **not**
    gated: `refresh` rotates an already-second-factored session in place (it never calls
    `mintSession`), and an anonymous user cannot have a confirmed enrollment (`finishSignIn`
    would find none and mint — but anon sign-in stays a direct `mintSession` for clarity).
    Anonymous **upgrade** via `signUp` is unenrolled by construction, so it mints.

13. **When `mfa` is absent from config, none of the A4 functions are registered and
    `finishSignIn` is a straight passthrough to `mintSession`** — the component surface and
    every existing return type stay exactly A1+A2+A3's, and existing deployments are
    byte-identical. MFA is strictly additive and opt-in.

## Schema (component tables, additive)

Three new tables; **no changes** to `users`, `accounts`, `sessions`, `authCodes`,
`authCounters`, `oauthState`, `oauthHandoff`. All additions pass the additive deploy gate
(new tables, all-optional-where-not-required fields).

```
mfaEnrollments {
  userId,               // v.id("users") — one enrollment per user in v1 (single TOTP factor)
  secretEncrypted,      // v1.<keyId>.<iv>.<ct>.<tag> envelope (decision 3) — NEVER the raw secret
  algorithm,            // "SHA1" (stored for forward-compat; default only in v1)
  digits,               // 6
  period,               // 30
  confirmedAt,          // v.optional(number) — absent until confirmMfaEnrollment proves a live code
  lastUsedStep,         // v.optional(number) — replay guard (decision 9)
  createdAt,
}
index byUserId on ["userId"]

mfaChallenges {         // the MFA-pending state (decision 6) — holds NO session token
  challengeHash,        // sha256base64url(pendingToken)
  userId,
  deviceLabel,          // v.optional(string) — carried to the eventual mint
  failedAttempts,       // second-factor attempt counter (decision 10)
  expiresAt,            // now + challengeTtlMs
  createdAt,
}
index byChallengeHash on ["challengeHash"]

mfaRecoveryCodes {      // one row per code (decision 7) — hashed at rest
  userId,
  codeHash,             // sha256base64url(rawRecoveryCode)
  createdAt,
}
index byUserId on ["userId"]
index byUserCode on ["userId", "codeHash"]   // O(1) consume-before-validate lookup
```

## Config (extends `defineAuth`)

```ts
defineAuth({
  // ...A1/A2/A3 options unchanged,
  mfa: {
    // Exactly one of these is required (mfa configured without a usable key → fail fast):
    encryptionKey?: string,                       // 32-byte key as base64 or hex (single-key)
    encryptionKeys?: Array<{ id: string; key: string }>,  // keyring; [0] is primary (rotation)

    issuer?: string,          // otpauth:// issuer label (default appName or "Stackbase")
    recoveryCodeCount?: number,   // default 10
    challengeTtlMs?: number,      // default 5 * 60 * 1000
    mfaAttempts?: number,         // default 5
    window?: number,              // ± step tolerance, default 1
    // algorithm/digits/period fixed at SHA1/6/30 in v1 (stored per-enrollment, not app knobs)
  },
})
```

Resolved into `AuthConfig.mfa?: MfaConfig` by a new `resolveMfaConfig(opts)` that decodes +
length-validates the key(s) and applies defaults. When `mfa` is absent, `config.mfa` is
`undefined` and `makeMfaModules` is never composed (decision 13).

## Component surface

All MFA functions are **mutations** — there is no external I/O (no email send), so A2's
mutation/action split is unnecessary; TOTP verification is pure crypto over the
deterministic `ctx.now()`.

Enrolled-user management (all require `ctx.auth.getUserId()` — an authenticated caller):
- `startMfaEnrollment()` → `{ secret, otpauthUri, digits, period, algorithm }`. Generates
  the secret, stores it **encrypted, unconfirmed**, returns the raw secret + URI once.
  Overwrites any prior unconfirmed enrollment; refuses if a **confirmed** enrollment already
  exists (must `disableMfa` first).
- `confirmMfaEnrollment({ code })` → `{ recoveryCodes: string[] }`. Decrypts, verifies a
  live TOTP, sets `confirmedAt`, generates + returns the recovery codes once.
- `disableMfa({ code })` → `null`. Requires a valid current TOTP or recovery code
  (decision 11). Deletes the enrollment + all recovery codes.
- `regenerateRecoveryCodes({ code })` → `{ recoveryCodes: string[] }`. Requires a valid
  current TOTP (decision 11). Replaces the recovery set, returns the new codes once.
- `getMfaStatus()` (query) → `{ enrolled: boolean; confirmed: boolean;
  recoveryCodesRemaining: number }`. Reactive (reads land in the read-set).

Second-factor gate (public — the caller is *not* yet signed in):
- `completeMfaSignIn({ pendingToken, code })` → `MintResult | commitThenThrow`.
  Consume-before-validate the challenge; verify TOTP (±window, replay-guarded) then recovery
  code; on success delete the challenge, advance `lastUsedStep` / consume the recovery row,
  and `mintSession`. Wrong factor → bump `failedAttempts`, delete the challenge at
  `mfaAttempts` (commit-then-throw), generic `"invalid code"`.

Changed first-factor return type: every gated function's success arm now returns
`MintResult | { mfaRequired: true; pendingToken: string; expiresAt: number }` (plus the
existing `NeedsVerification` / `commitThenThrow` arms). `MfaRequired` is additive — ungated
deployments (no `mfa` config) never produce it.

Typed error codes (code-as-message, per convention): `MFA_NOT_CONFIGURED` (an A4 function
called when `mfa` config is absent — defensive, normally unregistered), `MFA_ALREADY_ENROLLED`
(`startMfaEnrollment` when a confirmed enrollment exists), `MFA_NOT_ENROLLED`
(`confirm`/`disable`/`regenerate` with no enrollment), plus generic `"invalid code"` for
every second-factor / enrollment-confirm failure (wrong/expired/consumed/replayed — never
distinguished).

## Enrollment + second-factor data flow

**Enrollment (authenticated user):**
1. `startMfaEnrollment()` → generate 20-byte secret → base32 → build
   `otpauth://totp/{issuer}:{email}?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30`
   → AES-256-GCM encrypt (AAD=userId) → insert `mfaEnrollments` (no `confirmedAt`) →
   return `{ secret, otpauthUri }`. Client renders a QR of `otpauthUri`.
2. User scans; enters the 6-digit code. `confirmMfaEnrollment({ code })` → decrypt →
   `verifyTotp` → set `confirmedAt` + `lastUsedStep` → generate 10 recovery codes, store
   hashes, return raw → client shows them once (download/print). MFA is now active.

**Second-factor gate (sign-in):**
1. First factor succeeds (e.g. `signIn` verifies the password). Instead of `mintSession`,
   the handler calls `finishSignIn(ctx, config, userId, deviceLabel)`.
2. `finishSignIn` reads `mfaEnrollments.byUserId`; a **confirmed** row → mint a raw
   `pendingToken`, insert an `mfaChallenges` row (hash only), return
   `{ mfaRequired: true, pendingToken, expiresAt }`. No `mfaEnrollments` row → `mintSession`.
3. Client sees `mfaRequired`, prompts for the 6-digit code (or "use a recovery code"), calls
   `completeMfaSignIn({ pendingToken, code })`.
4. `completeMfaSignIn` looks up the challenge by hash; expired/missing → generic invalid.
   Verify TOTP (±window, `matchedStep > lastUsedStep`) → success: delete challenge, advance
   `lastUsedStep`, `mintSession(userId, deviceLabel)`. TOTP no-match → try recovery-code hash;
   success: delete challenge, delete the recovery row, `mintSession`. Total failure: bump
   `failedAttempts`; at `mfaAttempts` delete the challenge; `commitThenThrow("invalid code")`.
5. The `MintResult` flows to the client exactly as a normal sign-in would → handed to
   `createAuthClient.setSession`.

## Security / correctness

- **The pending state can never bypass `mintSession`.** The `mfaChallenges` row holds no
  token and confers no identity — `authContext.getUserId` only resolves `sessions` rows, so
  a pending challenge is invisible to every authenticated query/mutation. The only function
  that turns a challenge into a session is `completeMfaSignIn`, and it calls `mintSession`
  strictly *after* a verified second factor. `finishSignIn` is the single interposition
  point; a code review need only confirm that (a) no first-factor handler calls `mintSession`
  directly anymore (all route through `finishSignIn`), and (b) `completeMfaSignIn` is the
  lone new direct `mintSession` caller. A test enumerates every gated entry point and
  asserts an enrolled user gets `mfaRequired`, never a `token`.
- **Encrypted-secret key management** (decision 3): AES-256-GCM authenticated encryption,
  random per-secret IV, AAD-bound to `userId`, versioned + keyId-tagged envelope for
  rotation, fail-fast on a missing/short key. The raw secret exists in the clear only
  transiently — inside `startMfaEnrollment`'s return value (for the QR) and inside a decrypt
  during verification — never in a stored row or a log. GCM's tag makes tampering with a
  stored ciphertext a decryption failure, not a silent wrong-secret.
- **Determinism / OCC replay:** generating the secret, the IV, the pending token, and the
  recovery codes uses `node:crypto` CSPRNGs *inside* mutations — the established A1/A2
  precedent (`mintSession`/`_issueCode` generate CSPRNG material inside the mutation; an OCC
  replay simply regenerates fresh, unguessable material with no correctness impact). TOTP
  verification is a pure function of the (decrypted) secret and `ctx.now()`'s deterministic
  step, so it replays identically.
- **Replay & guessing** (decisions 9, 10): monotonic `lastUsedStep` blocks intra-window TOTP
  replay; the challenge-row attempt counter bounds online guessing to `mfaAttempts` and then
  destroys the pending window. The 10^6 six-digit space against a 5-attempt-per-window budget
  matches the RFC's operating assumptions.
- **Consume-before-validate under single-writer OCC** (decisions 6, 7): concurrent
  `completeMfaSignIn` calls with the same pending token, or concurrent redemptions of the
  same recovery code, resolve to exactly one winner — the same guarantee A2/A3 rely on for
  `authCodes`/`oauthHandoff`.
- **Anti-enumeration continuity:** `completeMfaSignIn` failures are all the generic
  `"invalid code"`; `getMfaStatus` is only callable by the authenticated user about
  themselves. MFA state is never exposed pre-authentication (the first factor already gates
  it).
- **Credential-boundary sharpness** (decision 12): reset-still-challenges is a deliberate
  security choice; the loss-of-both-factors path is recovery codes → support-side
  re-enrollment, documented, not a silent lockout.

## Client (`@stackbase/client`)

Minimal new machinery. The flows are ordinary mutations through the generated api. The one
addition to the sign-in ergonomics: a first-factor call may now resolve to
`{ mfaRequired: true, pendingToken, expiresAt }` instead of a mint result — the app detects
this, collects the code, calls `completeMfaSignIn`, and hands the resulting `MintResult` to
`createAuthClient.setSession` exactly as before. `createAuthClient` needs **no** change
(it only ever consumes a completed `SessionInfo`); the challenge/complete round trip is app
UI, documented with a reference implementation in the auth-demo (enrollment screen with QR,
recovery-code display, and the sign-in 2FA prompt). An optional thin helper
(`beginMfa(pendingToken)`-style) may be added if the auth-demo shows real friction, but it
is not required by this design.

## Testing

- Component-level (`@stackbase/test` `createTestStackbase` over the real engine):
  - **TOTP vector correctness**: `mfa/totp.ts` matches the RFC 6238 Appendix B published
    test vectors (SHA1) and RFC 4648 base32 round-trips — pure-unit, no engine.
  - **Encryption**: encrypt→decrypt round-trip; AAD mismatch (wrong userId) fails; a
    tampered ciphertext/tag fails; keyring rotation — a secret encrypted under `keyId` "1"
    still decrypts after "2" is prepended as primary; a missing/short key fails
    `resolveAuthConfig`.
  - **Enrollment**: `startMfaEnrollment` stores an encrypted (never raw) secret and returns
    a parseable `otpauth://` URI; sign-in is NOT gated until `confirmMfaEnrollment` sets
    `confirmedAt`; a wrong confirm code leaves MFA inactive; a re-`start` overwrites an
    unconfirmed enrollment; `start` on a confirmed enrollment → `MFA_ALREADY_ENROLLED`.
  - **The gate invariant**: enumerate every gated first-factor path (`signIn`, verified
    `signUp`, `verifyEmail`, `signInWithMagicLink`, `signInWithOtp`, `resetPassword`, and the
    A3 mint paths) and assert an enrolled user receives `{ mfaRequired: true }` with NO
    `token`; a non-enrolled user receives a normal mint; `completeMfaSignIn` then mints.
  - **Replay**: the same TOTP code accepted once is rejected on immediate re-presentation
    (`lastUsedStep`); a ±1-window skewed code is accepted.
  - **Recovery codes**: hashed at rest (no raw code in any row); each consumable exactly
    once; consumed code fails on replay; `regenerateRecoveryCodes` invalidates the old set;
    `recoveryCodesRemaining` decrements.
  - **Rate limit**: `mfaAttempts` wrong second-factor guesses delete the challenge
    (a correct code then fails — the pending window is destroyed); the counter survives the
    failed calls (commit-then-throw).
  - **Disable/regenerate re-auth**: both reject without a valid current factor; `disableMfa`
    removes the enrollment + all recovery codes and un-gates subsequent sign-in.
  - **Off-by-default**: no `mfa` config → none of the A4 functions registered, every
    existing return type byte-identical, `finishSignIn` a passthrough.
- E2E through the real `stackbase dev` server (`packages/cli/test/auth-mfa-e2e.test.ts`):
  a full round trip over a real `@stackbase/client`/WebSocket — enroll (derive the live code
  from the returned secret with the same `totp.ts`), confirm, sign out, sign in →
  `mfaRequired`, `completeMfaSignIn` → session works and a live subscription sees the
  identity; a recovery-code sign-in path; `disableMfa` un-gates.

## Non-goals (A4)

- **Multiple concurrent factors / factor types beyond one TOTP + recovery codes** — no
  WebAuthn/passkeys, no SMS/phone OTP (no SMS seam exists — carried from A2), no email-as-2FA.
  One confirmed TOTP enrollment per user in v1.
- **Per-app `algorithm`/`digits`/`period` knobs** — stored per-enrollment for forward-compat,
  fixed at SHA1/6/30 (authenticator-app compatibility) in the config surface.
- **Trusted-device / "remember this device for N days" 2FA skip** — every gated sign-in
  challenges; a remembered-device cookie/token is a future follow-on.
- **Step-up auth / per-operation MFA re-prompts** beyond the disable/regenerate re-auth.
- **Admin/tenant-forced MFA enrollment policy** (require-MFA-for-all) — app-level for now.
- **Automatic key rotation tooling / a re-encrypt-all migration** — the keyring supports
  rotation; a bulk re-encrypt CLI is deferred until demanded.
- **Encrypted-backup / export of the secret** — the secret never leaves the server except as
  the one-time enrollment QR.

## References consulted

- **RFC 6238** (TOTP), **RFC 4226** (HOTP / dynamic truncation), **RFC 4648** (base32) —
  the normative algorithms; Appendix B vectors drive the `totp.ts` unit tests.
- `.reference/convex-auth` (Apache-2.0), `.reference/better-auth` (MIT) — for the
  enrollment/verify/recovery-code UX and the "second factor gates the session" posture;
  adapted with attribution comments, never copied (FSL discipline).
- In-tree precedents: A1 `mintSession` chokepoint + hashed-at-rest tokens
  (`components/auth/src/functions.ts`), A2 `authCodes` hashed-code / consume-before-validate /
  attempt-counter model, A3 `oauthHandoff` "mint-authorization holds no token" +
  `oauthState.codeVerifier` recoverable-secret exception (`components/auth/src/external.ts`,
  `schema.ts`), `node:crypto` usage in `crypto.ts`.
