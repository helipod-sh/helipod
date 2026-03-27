# Auth follow-up — more built-in OAuth providers (design)

**Date:** 2026-03-20
**Status:** Approved (design presented and approved in-session)
**Context:** A follow-up to the completed auth arc (A1 session core, A2 email flows, A3 external
identity — all merged). A3 shipped the OAuth provider seam (`OAuthProvider` type,
`oauthProvider()`/`googleProvider()`/`githubProvider()` builders, the engine-mounted
`/api/auth/oauth/*` callback, the shared `_resolveExternalIdentity` linking core) with only
Google + GitHub built in. This slice adds four more built-in providers — **Microsoft, Discord,
Facebook, Apple** — and evolves the seam where a provider genuinely requires it. Every endpoint,
scope, and claim mapping below was verified against the providers' official docs (2026-03-20),
not guessed.

**Goal:** Ship `microsoftProvider`, `discordProvider`, `facebookProvider`, and `appleProvider`
as first-class builders on the A3 seam, plus the four bounded seam changes Apple and Microsoft
require, without weakening any A3 security invariant.

## Locked design decisions

1. **Identity always comes from the verified token/userinfo, never from untrusted callback
   fields.** For Apple's `form_post`, `sub`/`email`/`email_verified` come ONLY from the
   signature-verified `id_token`; the POST body's `user` JSON is used ONLY for a cosmetic
   display name and is never trusted for identity, linking, or verification.
2. **`emailVerified` stays strictly boolean and only `true` autolinks** (the A3 rule). Every new
   mapper coerces to a real boolean; an absent/unverified email → `emailVerified: false` → the
   `_resolveExternalIdentity` core creates a separate user, never links. No mapper ever emits a
   placeholder email or hardcodes `true`.
3. **Seam changes are additive and default-inert.** The four seam changes (async clientSecret,
   `responseMode` + POST callback, widened `mapClaims`, templated-issuer hook) are all optional
   fields / new-arg-with-default; Google/GitHub and every A3 behavior are byte-identical when the
   new fields are unset. A test proves the existing providers are unaffected.
4. **The MITM loopback/https guard (A3) applies to every new provider endpoint** — Microsoft
   discovery, Discord/Facebook endpoints, Apple's endpoints — through the same shared
   `assertUrlIsSecure`/`isLoopbackUrl`. No new fetched URL bypasses it.
5. **Apple's client secret is minted from a private key held in config, in the action layer.**
   The ES256 JWT is signed with `jose` (network/crypto is fine in the token-exchange action),
   cached, and re-minted before expiry. The private key never leaves the server and is never
   stored in a row.
6. **Microsoft's templated-issuer relaxation delegates ONLY the issuer string-equality check**,
   never JWKS signature validation. The token must still be signed by the keys from Microsoft's
   discovery `jwks_uri`; only the exact-`iss`-match is relaxed so a tenant-specific `iss` under
   the configured authority validates.

## Part A — Seam evolution (components/auth/src/oauth.ts + external.ts)

### A1. Async client secret

`OAuthProvider.clientSecret` widens from `string` to
`string | (() => string | Promise<string>)`. `exchangeAndExtractIdentity` (the token-exchange
step) resolves it (`typeof cs === "function" ? await cs() : cs`) immediately before building the
`oauth.ClientSecretPost(secret)` client-auth. Static-string providers are unchanged.

### A2. `response_mode=form_post` + POST callback

- New optional field `OAuthProvider.responseMode?: "query" | "form_post"` (default `"query"`).
  `buildAuthorizeUrl` emits `response_mode=form_post` only when set.
- The callback handler (`oauthHttp`'s `callback` phase, `external.ts`) currently reads
  `code`/`state` from the request URL's query (a GET). It gains a POST branch: when the request
  method is POST with an `application/x-www-form-urlencoded` body, parse `code`/`state`/
  `id_token`/`user` from the body instead. Both branches converge on the same downstream logic
  (consume the state row, exchange, resolve). oauth4webapi's `validateAuthResponse` accepts a
  `Request`/`URLSearchParams` from either source.
- **The engine route must allow POST to `/api/auth/oauth/:provider/callback`.** A3 registered the
  route via the `httpRoutes` seam; verify/extend the declared method set so POST reaches the
  handler (the plan's Task on the callback pins whether the httpRoutes declaration is
  method-specific and, if so, adds POST — a small, contained change to the auth component's route
  declaration, NOT the generic engine seam).
- **Security invariants preserved on the POST path (explicit):** the `state` row is still
  single-use consume-before-validate (CSRF defense holds regardless of transport); PKCE still
  binds the exchange; `resolveProvider` (own-property guard) still resolves `:provider`;
  `isAllowedRedirect` still gates `redirectTo`; identity still derives from the verified
  `id_token` only. The POST body is not a new trust source — it carries the same
  `code`/`state`/`id_token` a GET would, plus the cosmetic `user`.

### A3. Widened `mapClaims`

`mapClaims` signature becomes
`(claims, extra?: { user?: { name?: { firstName?: string; lastName?: string }; email?: string } }) => MappedIdentity`.
`exchangeAndExtractIdentity` threads the parsed first-auth `user` JSON (OIDC/form_post providers
only; `undefined` otherwise) as `extra`. Existing mappers ignore the second arg (default
`undefined`), so they're unchanged. Only `appleProvider`'s mapper reads it, to compose the
display name Apple sends exactly once.

### A4. Templated-issuer hook (Microsoft)

`OAuthProvider` (oidc) gains an optional `expectedIssuer?: string | ((claims) => string)`.
`authorizationServerFor`/the oauth4webapi config sets the library's `_expectedIssuer` from it
when present, so a multi-tenant `common` token whose `iss` is
`https://login.microsoftonline.com/{tenantid}/v2.0` validates. When unset, behavior is A3's
strict exact-match. **JWKS signature validation is unchanged in all cases.** A tenant-pinned
Microsoft config (a GUID authority) needs no relaxation and doesn't set it.

## Part B — The four provider builders (components/auth/src/oauth.ts)

All builders return an `OAuthProvider`; all mappers coerce `emailVerified` strictly.

### `discordProvider({ clientId, clientSecret, scopes? })` — OAuth2, zero seam change
- authorize `https://discord.com/oauth2/authorize`, token
  `https://discord.com/api/oauth2/token`, userinfo `https://discord.com/api/users/@me`.
- default scopes `["identify", "email"]`.
- mapClaims from `/users/@me`: `accountId = String(u.id)`; `email = u.email ?? undefined`;
  `emailVerified = u.verified === true`; `name = u.global_name ?? u.username`.

### `facebookProvider({ clientId, clientSecret, scopes?, graphVersion? })` — OAuth2
- Graph version constant default `"v25.0"` (one place). authorize
  `https://www.facebook.com/<v>/dialog/oauth`, token
  `https://graph.facebook.com/<v>/oauth/access_token`, userinfo
  `https://graph.facebook.com/<v>/me?fields=id,name,email` (the `fields` query is mandatory and
  must survive to the Bearer call).
- default scopes `["email", "public_profile"]`.
- mapClaims from `/me`: `accountId = String(u.id)`;
  `email = typeof u.email === "string" && u.email ? u.email : undefined`;
  `emailVerified = !!email` (Facebook only returns confirmed emails; email can be absent →
  false); `name = u.name`.

### `microsoftProvider({ clientId, clientSecret, tenant?, scopes? })` — OIDC + issuer hook
- `tenant` default `"common"` (values: `common` | `organizations` | `consumers` | a tenant
  GUID / `*.onmicrosoft.com`). `issuer` = `https://login.microsoftonline.com/${tenant}/v2.0`;
  discovery is derived by the existing OIDC path.
- default scopes `["openid", "profile", "email"]` (no `offline_access`).
- For `common`/`organizations`/`consumers`, set `expectedIssuer` to accept the tenant-specific
  `iss` under the configured authority host; a GUID tenant sets none (strict).
- mapClaims from id_token: `accountId = ${tid}.${oid}` (fallback `sub` if `oid` absent);
  `email = typeof c.email === "string" ? c.email : undefined`;
  `emailVerified = c.xms_edov === true` (Entra emits no `email_verified`; `xms_edov` is the
  integrator-enabled optional claim — documented); `name = c.name`.

### `appleProvider({ clientId, teamId, keyId, privateKey, scopes? })` — OIDC + all Apple seam changes
- issuer `https://appleid.apple.com` (discovery works); id_token RS256-verified via jwks.
- default scopes `["name", "email"]`; `responseMode: "form_post"`.
- `clientSecret` = an async function that mints (and caches until shortly before `exp`) the ES256
  JWT: header `{ alg: "ES256", kid: keyId }`, claims
  `{ iss: teamId, iat: now, exp: now + <≤6mo>, aud: "https://appleid.apple.com", sub: clientId }`,
  signed with `privateKey` via `jose.SignJWT`/`importPKCS8`. `clientId` is Apple's Services ID.
- mapClaims(claims, extra): `accountId = String(claims.sub)`;
  `email = typeof claims.email === "string" ? claims.email : undefined`;
  `emailVerified = claims.email_verified === true || claims.email_verified === "true"` (Apple
  sends string-or-boolean — the exact strict-boolean hazard A3's review caught, handled here);
  `name` composed from `extra?.user?.name` (`firstName` + `lastName`, first-auth only; undefined
  otherwise). Never read email from `extra.user` (identity from the id_token only, decision 1).

## Testing

- Builder unit tests (per provider): exact authorize/token/userinfo endpoints + scopes;
  mapClaims over representative payloads including the strict-`emailVerified` edges — Apple's
  string `"true"`/`"false"`, Discord `verified:false`, Facebook/Microsoft email-absent (all →
  `emailVerified:false`, no placeholder email); Microsoft `tid.oid` accountId; the Facebook
  `fields` param preserved on the userinfo URL.
- Apple client-secret minter: assert the produced JWT has the exact header (`alg:ES256`, `kid`)
  and claims (`iss`/`sub`/`aud`/`exp≤6mo`), and verifies against the public key with `jose`;
  assert caching (a second call within the window returns a cached secret; re-mints past the
  window).
- Seam-change tests: async `clientSecret` resolved at exchange; `buildAuthorizeUrl` emits
  `response_mode=form_post` only for Apple; the POST callback branch parses a urlencoded body and
  reaches the same downstream as GET; `expectedIssuer` accepts a tenant-specific Microsoft `iss`
  while an unrelated issuer still fails signature/JWKS.
- Default-inert proof: Google/GitHub providers + all A3 tests byte-identical (existing suite green
  unchanged; a targeted assertion that a static-string provider + GET callback path is untouched).
- E2E through the real `stackbase dev` server (extend `auth-external-e2e.test.ts` or a sibling):
  a loopback mock Apple-shaped provider drives a `form_post` POST callback → identity from the
  mock's signed id_token, display name from the POST `user` JSON → session minted → live `whoami`
  subscription sees it. Confirms the POST route works end-to-end and identity ignores the `user`
  JSON's email.

## Docs

`docs/enduser/build/auth.md` External-identity section: add each provider's setup (credentials,
where to register the engine callback URL, provider-specific notes — Microsoft's `xms_edov`
optional-claim requirement for autolinking, Apple's Services ID + `.p8` key + the form_post
note, Facebook's Graph-version pin). Note the identity-from-verified-token / name-cosmetic split
for Apple. Native `@stackbase/*` imports only.

## Non-goals

- Provider access-token storage/refresh (unchanged from A3 — identity at sign-in, not API access).
- Providers beyond these four (the `oauthProvider()` seam stays public for the rest).
- Apple's `transfer_sub` app-transfer remapping (a rare migration event; documented as a known
  boundary, not handled).
- Per-provider account-token revocation / sign-out-from-provider.

## Reference

Endpoints/scopes/claims verified 2026-03-20 against Microsoft Entra, Discord, Meta Graph
(v25.0), and Apple developer docs + live discovery. Microsoft multi-tenant issuer failure
corroborated by convex-auth #304 / next-auth #6138 on the same oauth4webapi stack.
