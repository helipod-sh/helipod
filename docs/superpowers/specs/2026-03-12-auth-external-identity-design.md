# Auth slice A3 — external identity (design)

**Date:** 2026-03-12
**Status:** Approved (design presented and approved in-session)
**Arc context:** Final slice of the three-slice auth arc — A1 session core (SHIPPED `4fd0ac1`:
mintSession, hashed pairs, rotation/reuse detection, device mgmt, anonymous), A2 email flows
(SHIPPED `e0b595f`: EmailProvider seam, verification/reset/magic-link/OTP, the authCodes
ephemeral-row machinery, anti-enumeration, the first-mailbox-proof credential boundary), A3
external identity (this). Everything mints through A1's `mintSession` and composes with A2's
`accounts`/`users` model and the first-mailbox-proof rule.

**Goal:** Give `@stackbase/auth` its external-identity surface: **social OAuth** (Google +
GitHub via engine-mounted httpAction callbacks, behind a provider seam for more) and a
**third-party-JWT / OIDC verifier** (Clerk / Auth0 / any OIDC issuer as the identity provider).
Cookie-free (WebSocket-first), account-linking safe against the classic pre-registration
takeover, minting through the one A1 chokepoint.

## Libraries (locked)

- **`oauth4webapi`** (panva, MIT, zero-dependency, OpenID Certified™) — the OAuth2/OIDC
  protocol engine for the social-login flow (discovery, PKCE, authorization URL, code→token
  exchange, id_token validation). It has NO named providers, by design: we ship a small
  internal provider registry (`googleProvider`/`githubProvider` builders) on top of it.
- **`jose`** (panva, MIT, zero-dependency) — JWKS fetch + JWT signature/claims verification for
  the third-party-JWT half.
- Both are Fetch-based and run under Bun and Node. Pinned to exact versions (oauth4webapi does
  not strictly follow semver). Added as `@stackbase/auth` dependencies.

## Part 1 — Social OAuth

### Provider registry

`defineAuth({ oauth: { providers: { google: googleProvider({ clientId, clientSecret, scopes? }),
github: githubProvider({ clientId, clientSecret, scopes? }) }, redirectAllowlist: string[] } })`.

- `googleProvider(...)` — an OIDC provider: carries the discovery issuer
  (`https://accounts.google.com`); oauth4webapi auto-configures endpoints from
  `.well-known/openid-configuration`; identity comes from the verified `id_token` (sub, email,
  email_verified, name).
- `githubProvider(...)` — a NON-OIDC provider (GitHub issues no `id_token`): carries the four
  explicit endpoints (authorize `https://github.com/login/oauth/authorize`, token
  `.../access_token`, userinfo `https://api.github.com/user`, emails
  `https://api.github.com/user/emails`) and a claim mapper. After token exchange we fetch
  `/user` + `/user/emails` with the access token to get `{ id, email, emailVerified, name }`
  (GitHub's `emails` API marks which address is verified + primary).
- A provider config is a plain object (`{ kind: "oidc" | "oauth2", ...endpoints, scopes,
  mapClaims }`) so a new provider is a config entry, not a code change. Only google + github ship
  built-in; the seam is public.

### Routes (engine-mounted, reserved, cookie-free)

Two browser-hittable httpAction routes, mounted by the boot core at reserved paths when the
auth component is composed — mirroring how `packages/cli/src/boot.ts` engine-mounts the storage
component's `/api/storage/*` handlers (Task 1 pins the exact component→boot route-contribution
seam; the parallel to `composeComponents`' existing `drivers` collection is the model):

- `GET /api/auth/oauth/:provider/start?redirectTo=<app-url>` — the sign-in entry the app links
  to. Generates `state`, PKCE `code_verifier`, and (OIDC) `nonce`; writes an `oauthState` row
  (below); 302-redirects to the provider's authorization URL (built by oauth4webapi). If the
  caller is already authenticated (presents a valid session via the `Authorization` header),
  the row records `linkUserId` for an explicit link-to-current-account flow.
- `GET /api/auth/oauth/:provider/callback?code=&state=` — the provider's redirect target.
  Consumes the `oauthState` row (single-use, consume-before-validate), rejects on state
  mismatch, exchanges `code`+`code_verifier` for tokens (oauth4webapi), validates the `id_token`
  against the stored `nonce` (OIDC) or fetches userinfo (github), resolves/links the account and
  mints a session (Part 3), then 302-redirects to `redirectTo` with a one-time **handoff code**
  (never the session token itself) in the fragment: `redirectTo#code=<handoff>`.

### Session handoff (delivering a session out of a browser redirect, cookie-free)

A browser redirect can't hand a session to a WebSocket client directly, and we refuse cookies.
So the callback resolves/links the identity and does all its writes (Part 3 —
provision/link/revoke), then writes a single-use short-TTL (`~2 min`) `oauthHandoff` row that
**authorizes a mint for the resolved `userId`** (NOT the minted tokens), and redirects with the
opaque handoff code in the URL **fragment** (not the query — fragments aren't sent to servers or
logged in Referer). The app reads the fragment on load and calls an action
`completeOAuthSignIn(handoffCode)` which consumes the row and **mints the session then** (raw
tokens returned directly to the app, never stored) → `createAuthClient.setSession(...)`.
Deferring the mint to the exchange preserves A1's hashed-at-rest invariant — no raw session
token is ever written to a row. The consequence is a brief (≤2 min) window between callback and
exchange during which the completing user holds no session (any prior sessions were revoked at
the callback if this was a first-mailbox-proof link); acceptable, as it is an active sign-in the
user is in the middle of completing. Only a one-time code transits the URL; tokens never do.

### Schema (component tables, additive)

- `oauthState`: `{ stateHash, provider, codeVerifier, nonce?, redirectTo, linkUserId?,
  expiresAt, createdAt }`, index `byStateHash`. TTL ~10 min, single-use. `stateHash` =
  SHA-256(state) (hashed at rest — we only ever COMPARE state). NOTE: `codeVerifier` (and
  `nonce`) are stored RECOVERABLE (not hashed), because PKCE requires sending the original
  verifier to the token endpoint — the server needs the value back, it can't compare a hash.
  This is safe: they are single-use, ~10-min-TTL, server-only transaction secrets, never
  returned to any client, and useless without the matching authorization code (exactly what a
  PKCE cookie would hold). This is a deliberate, documented exception to hashed-at-rest, scoped
  to non-credential transaction secrets.
- `oauthHandoff`: `{ handoffHash, userId, deviceLabelHint?, expiresAt, createdAt }`, index
  `byHandoffHash`. TTL ~2 min, single-use. Authorizes a mint for `userId` at the exchange —
  holds NO session token (the mint happens in `completeOAuthSignIn`, tokens returned directly).
- `accounts` (existing, unchanged shape `{ userId, provider, accountId, secret? }`, index
  `byAccount` on `[provider, accountId]`): OAuth identities are rows with `provider: "google"` /
  `"github"`, `accountId` = the provider's stable subject id, `secret` unused (no password).
- `users.emailVerified` (from A2) participates unchanged.

### Security (Part 1)

- **CSRF via state**: the `oauthState` row is the state store; a callback whose `state` doesn't
  match a live row is rejected. PKCE `code_verifier` binds the code exchange to this browser.
  OIDC `nonce` binds the `id_token` to this request.
- **Open-redirect defense**: `redirectTo` MUST match `redirectAllowlist` (exact origin +
  path-prefix match); a non-allowlisted `redirectTo` is rejected at `/start` before any redirect.
- **Hashed at rest**: state and handoff codes are SHA-256'd; the raw values live only in the URL
  in flight.
- **Consume-before-validate** at the callback and the handoff exchange (single winner under
  single-writer OCC).
- **No token in URL**: only the one-time handoff code transits, in the fragment.
- **`allowInsecureRequests` is test-only and cannot weaken production**: oauth4webapi refuses
  `http://` endpoints by default (MITM protection). The E2E's loopback mock needs `http://`, so
  an `allowInsecureRequests` path exists — but it MUST be gated so a real deployment can never
  enable it against a non-loopback issuer: honor it only when the provider's endpoints are
  loopback (`127.0.0.1`/`localhost`), never from public config. A production OAuth provider on
  `http://` is rejected regardless. (Task 1 pins the exact gate.)

## Part 2 — Third-party JWT / OIDC (Clerk / Auth0 / any OIDC issuer)

### Model: exchange, not per-request (a deliberate simplification)

Identity resolution (`getUserId`) runs in QUERIES, which cannot do network I/O (JWKS fetch) or
writes (JIT-provisioning). So third-party JWTs are NOT verified per-request. Instead:

- `defineAuth({ jwt: { issuers: [{ issuer, audience, jwksUrl? }] } })` configures trusted
  issuers.
- **`signInWithIdToken(idToken, deviceLabel?)`** — an ACTION (network I/O allowed): jose
  `createRemoteJWKSet(issuer)` fetches + in-process-caches the JWKS, `jwtVerify` validates
  signature + `iss` (must match a configured issuer) + `aud` + `exp`/`nbf`. It extracts
  `{ sub, email, email_verified, name }`, then delegates to an internal mutation that
  JIT-provisions and mints (Part 3). Returns a normal A1 mint result → the app calls
  `createAuthClient.setSession(...)` and thereafter uses the Stackbase session like every other
  flow. A short-lived third-party token is exchanged ONCE, not presented on every request.
- This deletes the driver + JWKS-cache-table subsystem an early design sketch had (verification
  is a one-time action, so a live in-process-cached fetch is correct and sufficient). It is a
  deliberate divergence from Convex Auth's per-request-JWT-is-the-identity model, documented as
  such: it fits our session-centric architecture, keeps reactive revocation, and gives external
  identities a real local `userId`.

### Provisioning + schema (Part 2)

- Third-party identities are `accounts` rows with `provider: "oidc:<issuer>"`,
  `accountId: <sub>`. On first valid exchange, JIT-create the `users` row (email from the token
  if present) + the `accounts` row; on subsequent exchanges, look up by `byAccount` and mint for
  the existing user. So an external identity is a first-class local user (owns rows, appears in
  the dashboard, works with authz, is revocable) — not a stateless subject.
- No new tables beyond Part 1's; reuses `accounts`/`users`.

### Security (Part 2)

- Full `jose` validation: signature against the issuer's JWKS, `iss` allowlist, `aud` match,
  `exp`/`nbf` against real time (this is an action — wall-clock is fine here; the *mint* happens
  in the delegated mutation using `ctx.now()`). An unknown-kid / bad-signature / wrong-aud /
  expired token → generic auth failure.
- The email-verified linking rule (Part 3) applies identically to a token whose `email_verified`
  claim is true.

## Part 3 — Account resolution, linking, and the takeover defense (shared by both parts)

The single resolution path both the OAuth callback and `signInWithIdToken` delegate to
(internal mutation, mints via A1 `mintSession`):

1. **Returning identity** — `accounts` has a row for `[provider, accountId]` → mint for that
   `userId`. Done. (No linking decision; this identity is already bound.)
2. **New identity, caller already signed in with `linkUserId`** — attach the `accounts` row to
   `linkUserId` (the caller proved they hold both the session and the external identity). Mint.
3. **New identity, provider asserts a VERIFIED email that matches an existing user** — **link**:
   add the `accounts` row to that user, AND apply A2's **first-mailbox-proof** helper
   (`markVerifiedRevokingIfFirstProof`, the FLIP-GATED rule): if this sets the user's
   `emailVerified` from false/unset → true, delete ALL that user's existing sessions before
   minting; if the user was ALREADY verified, no wipe. This is the takeover defense AND it is
   sufficient BECAUSE the takeover only works against an unverified existing account: if the
   existing account was an attacker's unverified password registration of the victim's email,
   the verified Google/Clerk sign-in flips false→true and revokes the attacker's parked
   sessions (the true owner takes over); if the existing account was already verified (the
   legitimate owner just adding a second login method), there is no flip, no wipe, and they stay
   signed in on their other devices — better UX, still safe, since an already-verified account
   was already proven to belong to whoever verified it. (This is the SAME flip-gated helper A2's
   verifyEmail/magic/OTP use — NOT an unconditional wipe. Adjudicated at plan stage: an
   unconditional wipe would needlessly log out legitimate users adding a provider, and the
   flip-gate already covers every attack case.)
4. **New identity, provider does NOT assert a verified email (or gives none)** — **never
   auto-link.** Create a NEW user + the `accounts` row. (An unverified external email is not
   proof of anything; auto-linking on it is the exact attack vector.)

Errors are code-as-message (A1/A2 convention). Generic auth failures do not distinguish
sub-cases that could leak account existence.

## Config surface (extends A1/A2 `defineAuth`)

```ts
defineAuth({
  // ...A1 + A2 options unchanged,
  oauth?: {
    providers: Record<string, OAuthProvider>,   // googleProvider(...)/githubProvider(...)/custom
    redirectAllowlist: string[],                  // required if oauth present; open-redirect guard
    stateTtlMs?: number,      // default 10 * 60 * 1000
    handoffTtlMs?: number,    // default 2 * 60 * 1000
  },
  jwt?: {
    issuers: Array<{ issuer: string; audience: string; jwksUrl?: string }>,
  },
})
```

When `oauth`/`jwt` are absent, none of the A3 functions/routes are registered — the surface
stays exactly A1+A2 (conditional registration, same discipline A2 used; a test proves it).

## Component surface

- Engine-mounted httpActions: `/api/auth/oauth/:provider/start`,
  `/api/auth/oauth/:provider/callback` (Part 1).
- Actions: `completeOAuthSignIn(handoffCode)` (exchange the handoff for the mint result);
  `signInWithIdToken(idToken, deviceLabel?)` (Part 2).
- Internal mutations (not client-callable, `_`-prefixed): `_startOAuth` (write the state row —
  called by the start route), `_resolveExternalIdentity` (the Part-3 link/provision/mint path —
  called by the callback and by signInWithIdToken).
- New builders exported from `@stackbase/auth`: `googleProvider`, `githubProvider`, and the
  `OAuthProvider` type for custom providers.

## Testing

- Component-level (`@stackbase/test`): the Part-3 resolution matrix — returning-identity mint;
  link-while-signed-in; verified-email autolink revokes pre-existing sessions (the takeover
  defense, with the attacker-pre-registered-unverified-account scenario as a named test);
  unverified-email NEVER autolinks (creates a separate user); JIT-provision on first
  third-party-JWT sight; hashed-at-rest state/handoff (no raw code in any row); consume-before-
  validate single-winner; state-mismatch rejection; open-redirect rejection.
- Protocol-level with stubbed HTTP (mock the provider token/userinfo endpoints and a mock OIDC
  issuer + JWKS): oauth4webapi code→token→id_token happy path; PKCE/nonce mismatch rejection;
  GitHub non-OIDC userinfo path; jose JWKS signature-invalid / expired / wrong-aud / wrong-iss
  rejection. (No live third-party network in the suite.)
- E2E through the real `stackbase dev` server (`packages/cli/test/auth-external-e2e.test.ts`):
  a mock OAuth provider served by the same test server (or a stub http endpoint) drives the full
  `/start → provider → /callback → handoff → completeOAuthSignIn → setSession` round-trip, with
  a live `whoami` subscription seeing the new identity; a `signInWithIdToken` round-trip against
  a locally-minted test JWT + JWKS; the verified-email-link revocation fanning out reactively.
- Provider-builder unit tests (endpoint/scope shape); the auth-demo gains "Sign in with
  Google/GitHub" buttons + a "sign in with a third-party token" example.

## Docs

`docs/enduser/build/auth.md`: the "External identity" section — OAuth setup (the provider
builders, credentials, the redirect allowlist, the `/api/auth/oauth/*` routes, the handoff
flow), the third-party-JWT setup (issuer config, `signInWithIdToken`, the exchange-not-
per-request model + why it diverges from Convex), the account-linking safety rules, the security
table. This finally makes the file's long-standing "JWKS/OIDC roadmap" note TRUE — replace it
with real documentation. `components/auth/README.md`: move OAuth + third-party-JWT from
roadmap/limitations to shipped; the arc is complete.

## Non-goals (A3)

- More than Google + GitHub built-in (the provider seam is public; more are config/fast-follows).
- Storing + refreshing provider access tokens for calling provider APIs on the user's behalf
  (we take the identity at sign-in, not long-lived API access — a future "connections" feature).
- Per-request stateless third-party-JWT identity (Convex's model) — fights the write-in-query /
  no-I/O-in-query constraints; the exchange model is the native fit. Documented divergence.
- Being an OAuth/OIDC authorization SERVER (issuing our own OAuth tokens to third parties) — we
  are the Relying Party / a token verifier, not an IdP.
- SAML; enterprise SSO directory sync.

## Reference implementations consulted

`.reference/convex-auth` (Apache-2.0, `@auth/core`-based OAuth + platform-verified third-party
JWT) and `.reference/better-auth` (MIT, its OAuth + accountLinking config + JWT plugin). Adopted:
the verified-email-required-for-autolink rule and trusted-link-while-signed-in (both references
converge on this as the takeover defense); provider-registry shape. Diverged: no cookies (both
use them — we use ephemeral rows + a fragment handoff code); exchange-model third-party JWT (vs
Convex's per-request-JWT-is-identity) because our identity resolution is deterministic/read-only;
first-mailbox-proof session revocation on verified-email link (stronger than either reference's
link behavior, consistent with our A1/A2 credential-boundary rule).
