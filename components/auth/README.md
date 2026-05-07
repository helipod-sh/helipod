# @stackbase/auth

First-party authentication for Stackbase: email + password accounts (argon2id hashing, per-call
random salt, constant-time verification, legacy-scrypt migration), a hardened session model (short
access tokens + rotating refresh tokens with reuse detection, all hashed at rest), device
management (`listSessions`/`revokeSession`/`revokeOtherSessions`), anonymous sign-in with
in-place upgrade, a full email-flows surface — email verification, password reset, magic-link
sign-in, and one-time-code (OTP) sign-in, opt-in via `defineAuth({ email: {...} })`, with
`consoleEmail()`/`resendEmail()` provider adapters and a documented SMTP recipe — and **external
identity**: OAuth sign-in (Google + GitHub built in, any OIDC/OAuth2 provider via the `oauthProvider`
seam) through engine-mounted, cookie-free callback routes with fragment handoff, and third-party
JWT/OIDC verification (Clerk, Auth0, any JWKS-publishing issuer) via `signInWithIdToken` — both
opt-in (`defineAuth({ oauth: {...} })` / `defineAuth({ jwt: {...} })`) and both resolving/linking
through one shared, safety-first account-linking core. It also ships **TOTP two-factor
authentication** (RFC 6238, opt-in via `defineAuth({ mfa: {...} })` — AES-256-GCM-encrypted secret,
one-time recovery codes, gating every first-factor path behind `finishSignIn` without ever bypassing
the mint chokepoint) and **passkeys / WebAuthn** (opt-in via `defineAuth({ passkeys: {...} })` —
register-while-authed + usernameless or email-scoped sign-in, atomic signature-counter clone
detection, anti-enumeration, reactive device management, crypto confined to actions behind the sole
`@simplewebauthn/server` seam). `ctx.auth.getUserId()` resolves identity inside the transaction, so
session revocation is reactive — including the revocation a verified-email external-identity link
triggers, and a passkey sign-in honors an enrolled second factor like every other first factor.
Runtime-agnostic (`node:crypto`) — Node.js and Bun.

Configure via `defineAuth(options?)`; `export const auth = defineAuth()` uses the defaults.
Session/token details, the client `createAuthClient`, and the full external-identity setup +
security model are documented in `docs/enduser/build/auth.md`.

Reference implementations consulted: convex-auth (Apache-2.0) and better-auth (MIT) — adapted with
attribution, never copied. The arc (A1 session core, A2 email flows, A3 external identity) is
complete, extended with TOTP two-factor authentication and passkeys/WebAuthn. Reserved follow-ons:
a passkey **satisfying** an MFA step-up (today a passkey is strictly a first factor), WebAuthn
attestation-format / MDS verification, and SMS-based second factor.

## Known limitations

1. **No storage-level unique index on `accounts(provider, accountId)`** — uniqueness is enforced by
   an application-level duplicate check in `signUp`/the external-identity resolution core, correct
   under single-writer OCC serialization (Tier 0 / Tier 1). A multi-writer engine (Tier 2+) would
   require a DB-level unique constraint.
2. **Sessions in one browser context** — the client single-refresher serializes rotation across tabs
   via Web Locks; two independent *processes* sharing one refresh token is unsupported.
3. **No httpOnly-cookie / CSRF mode** — Stackbase is WebSocket-first; identity flows over `SetAuth`,
   not headers. The session model (short access TTL + rotation + reuse detection) is the theft
   mitigation. See the auth doc's "localStorage vs. cookies" note.
4. **No SMS-based OTP** — the OTP flow is email-only; there's no phone/SMS channel.
5. **No email-change flow** — `users.email` has no first-party "change my email" mutation; a project
   composing its own would need to handle re-verification itself.
6. **No per-IP rate limiting** on the email flows — abuse defense is per-`(email, flow)` cooldown
   plus a deployment-global send throttle, not per-source; see the auth doc's "Abuse defense" table.
7. **External identity is not a general SSO/IdP surface** — Stackbase is an OAuth/OIDC *client* and a
   third-party-JWT *verifier*, never an identity *provider*: no SAML, and Stackbase never issues
   tokens another service could verify.
8. **No provider access-token storage/refresh** — `signInWithIdToken`/the OAuth flow trade the
   external identity for a Stackbase session and then discard the provider's own
   access/refresh/id token; there is no facility for later calling the provider's own API on the
   user's behalf (e.g. re-fetching their Google Drive files). A project needing that stores and
   refreshes those tokens itself.
9. **Per-request-stateless-JWT is a deliberate non-goal** — `signInWithIdToken` is an *exchange*
   (verify once, mint a real DB-backed session), not Convex's per-request-JWT-is-identity model; see
   the auth doc's "Third-party JWT / OIDC setup" section for the rationale.
10. **Abandoned WebAuthn challenges are not reaped** — a passkey `begin*` ceremony that is never
    finished (or expires unconsumed) leaves a single-use `webauthnChallenge` row behind. This is
    bounded storage growth, not an auth or performance issue (a consumed challenge is deleted, and
    lookups stay O(1) on the `byChallenge` index — an expired row can never be redeemed). A periodic
    reaper keyed on `expiresAt` (the file-storage `storageReaper` driver pattern) is the reserved
    remedy.
