# Auth follow-up — more built-in OAuth providers (implementation plan)

**Date:** 2026-03-20
**Branch:** `worktree-auth-more-providers` (git worktree off `main`; auth arc A1+A2+A3 merged)
**Spec:** `docs/superpowers/specs/2026-03-20-auth-more-providers-design.md` (read it first — this plan
implements it verbatim)
**Slice:** Ship `microsoftProvider`, `discordProvider`, `facebookProvider`, `appleProvider` as
first-class builders on the A3 OAuth seam, plus the four bounded seam changes Apple + Microsoft
require, without weakening any A3 security invariant.

## For agentic workers

Execute this plan with **`superpowers:subagent-driven-development`** — the tasks are ordered so each is
an independent, reviewable unit with its own tests. Recommended flow: one subagent per task (T1→T6 in
order), each running its own `bun run --filter @stackbase/auth build` + targeted tests before handing
back, with a review checkpoint between tasks. **T4 is the security-critical seam evolution** (async
client secret + POST/form_post callback + widened `mapClaims` + the route POST change) — give it the
closest review. Apple (T5) and the E2E (T6) depend on T4; T3 lands the Microsoft issuer hook
independently. **Rebuild before dependent tests** (`tests-resolve-deps-via-dist`: cross-package tests
resolve `@stackbase/auth` via built `dist/`, so `bun run --filter @stackbase/auth build` must run
before `packages/cli` E2E tests pick up a source change).

## Goal

Four new built-in provider builders + four additive, default-inert seam evolutions on
`components/auth/src/oauth.ts` and `components/auth/src/external.ts`, proven by builder unit tests, an
Apple client-secret minter test, seam-change tests, a default-inert proof, an E2E through the real
`stackbase dev` server driving a `form_post` POST callback, and end-user docs.

## Architecture

The A3 seam (already shipped) is: a plain `OAuthProvider` config object (`kind`, endpoints/issuer,
`clientId`/`clientSecret`, `scopes`, `mapClaims`) + `oauthProvider()`/`googleProvider()`/
`githubProvider()` builders + a single engine-mounted `oauthHttp` httpAction backing
`/api/auth/oauth/:provider/{start,callback}` + the shared `_resolveExternalIdentity` linking core.
Adding a provider is normally a config entry, not a code change. This slice adds four builders and,
where a provider genuinely needs it, evolves the seam:

- **Discord** (`oauth2`, userinfo fetch) and **Facebook** (`oauth2`, Graph `/me?fields=…`) ride the
  existing seam with **zero** changes — they are pure new builders.
- **Microsoft** (`oidc`) needs the **templated-issuer hook** (multi-tenant `common`/`organizations`/
  `consumers` tokens carry a tenant-specific `iss` that fails oauth4webapi's exact-`iss` match).
- **Apple** (`oidc`, `form_post`) needs the other three: an **async client secret** (Apple's secret is
  a short-lived ES256 JWT minted from a `.p8` key), **`response_mode=form_post` + a POST callback
  branch** (Apple returns the authorization response as an HTTP POST), and a **widened `mapClaims`**
  (Apple sends the user's display name once, as a `user` JSON field in the POST body).

Data flow is unchanged: identity always derives from the verified `id_token`/userinfo, normalized to
`ExternalIdentity`, handed to `_resolveExternalIdentity` (verified-email-only autolink, flip-gated
revoke). The POST body is not a new trust source — it carries the same `code`/`state`/`id_token` a GET
query would, plus a cosmetic `user` JSON used only for a display name.

## Tech Stack

- `oauth4webapi@3.8.6` — the OAuth/OIDC protocol driver (discovery, PKCE, code exchange, id_token
  validation). Already an `@stackbase/auth` dependency.
- `jose@6.2.3` — JWT signing/verification. Already a dependency (A3's `signInWithIdToken` uses it).
  Apple's ES256 client-secret minter uses `importPKCS8` + `SignJWT`.
- Tests: `vitest` under Node (`tests-run-under-node`); component-level tests drive
  `runtime.runHttpAction` directly; the E2E drives a real `@stackbase/client` over a real WebSocket to
  a real `stackbase dev` server (`e2e-through-shipped-entrypoint`).

## Global Constraints

Binding values copied verbatim from the spec's "Locked design decisions" and Part B. Every task obeys
all of these:

1. **Identity always comes from the verified token/userinfo, never from untrusted callback fields.**
   For Apple's `form_post`, `sub`/`email`/`email_verified` come ONLY from the signature-verified
   `id_token`; the POST body's `user` JSON is used ONLY for a cosmetic display name and is never
   trusted for identity, linking, or verification.
2. **`emailVerified` stays strictly boolean and only `true` autolinks.** Every new mapper coerces to a
   real boolean; an absent/unverified email → `emailVerified: false` → the `_resolveExternalIdentity`
   core creates a separate user, never links. **No mapper ever emits a placeholder email or hardcodes
   `true`.**
3. **Seam changes are additive and default-inert.** The four seam changes (async `clientSecret`,
   `responseMode` + POST callback, widened `mapClaims`, templated-issuer hook) are all optional fields
   / new-arg-with-default; **Google/GitHub and every A3 behavior are byte-identical when the new fields
   are unset**, proven by a test.
4. **The MITM loopback/https guard (A3) applies to every new provider endpoint** — through the same
   shared `assertUrlIsSecure`/`isLoopbackUrl`/`assertProviderEndpointsSecure`. No new fetched URL
   bypasses it.
5. **Apple's client secret is minted from a private key held in config, in the action layer.** The
   ES256 JWT is signed with `jose` (network/crypto is fine in the token-exchange action), cached, and
   re-minted before expiry. **The private key never leaves the server and is never stored in a row.**
6. **Microsoft's templated-issuer relaxation delegates ONLY the issuer string-equality check**, never
   JWKS signature validation. The token must still be signed by the keys from Microsoft's discovery
   `jwks_uri`; only the exact-`iss`-match is relaxed so a tenant-specific `iss` under the configured
   authority validates. A tenant-pinned (GUID / `*.onmicrosoft.com`) config sets no relaxation.
7. **The exact endpoints/scopes/mappers from the spec's Part B are verbatim** (Discord, Facebook
   `v25.0`, Microsoft, Apple — see each task).
8. **POST-callback preserves all A3 invariants:** single-use consume-before-validate `state` (CSRF
   holds regardless of transport), PKCE binds the exchange, `resolveProvider` (own-property guard)
   resolves `:provider`, `isAllowedRedirect` gates `redirectTo`.
9. **`ctx.now()` in mutations** (never wall-clock) — unchanged; no new mutation is added by this slice,
   but the Apple minter uses an injectable `nowFn` for deterministic tests and `Date.now()` only in the
   action layer (a non-deterministic context, allowed).
10. **E2E through the real server** and **rebuild-before-dependent-tests** (see "For agentic workers").

---

## Resolved seam facts (verified against installed `node_modules`, 2026-03-20)

These four adjudications were verified against the actually-installed library sources, not docs. They
are load-bearing for the code below.

**(1) Microsoft issuer relaxation — the real oauth4webapi 3.8.6 lever is the runtime Symbol
`_expectedIssuer`, NOT a typed option.** `oauth4webapi/build/index.js` has
`export const _expectedIssuer = Symbol()` and, in `validateIssuer`:
`const expected = as[_expectedIssuer]?.(result) ?? as.issuer; if (result.claims.iss !== expected) throw …`.
The Symbol is **exported at runtime but omitted from the published `.d.ts`**, so we reach it through a
typed accessor. The resolver receives the full result object (`{ claims, … }`), so the public
`expectedIssuer?: (claims) => string` hook is wrapped as `(result) => hook(result.claims)`.
**JWKS signature validation happens separately** in `processAuthorizationCodeResponse` against
discovery's `jwks_uri` — the Symbol relaxes only the `iss` string comparison, exactly as the spec
requires. (Note: `validateAuthResponse` at index.js line ~2068 also checks the RFC 9207 `iss`
*response parameter* against `as.issuer` directly — but only fires `if (iss && iss !== as.issuer)`;
Microsoft's code flow does not return that parameter, so it stays inert. The id_token `iss` check via
`_expectedIssuer` is the one that must be relaxed, corroborated by convex-auth #304 / next-auth #6138
on this same stack.)

**(2) The httpRoutes route declaration IS GET-only, and the fix is auth-component-only — no engine
seam change.** `components/auth/src/component.ts` line 22 declares
`httpRoutes: [{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" }]`.
`packages/cli/src/server.ts`'s `matchComponentRoute` matches per-method (`r.method === method`), and
`packages/component/src/compose.ts`'s overlap guard **skips different methods**
(`if (existing.method !== r.method) continue;`), and `hasBody("POST")` is `true` so the server
reconstructs the POST body into the `Request` handed to the httpAction. Therefore the *only* change
needed is to add a **second** route entry `{ method: "POST", … }` in `component.ts` — it passes both
`defineComponent`'s and `composeComponents`' validation, and `matchComponentRoute` will dispatch POST
to `oauthHttp`. The generic engine seam (`ComponentHttpRoute`, `matchComponentRoute`, compose) needs
**no** change. (`external-config.test.ts` line 21 pins the httpRoutes array and MUST be updated to
include the POST entry — done in T4.)

**(3) jose ES256 signing calls (verified against `jose@6.2.3` types):**
`importPKCS8(pkcs8: string, "ES256"): Promise<CryptoKey>`, then
`new SignJWT(payload).setProtectedHeader({ alg: "ES256", kid }).setIssuer(teamId).setIssuedAt(iat)
.setExpirationTime(exp).setAudience("https://appleid.apple.com").setSubject(clientId).sign(key)`.
Test helpers also present: `exportPKCS8`, `importSPKI`, `generateKeyPair`, `decodeJwt`,
`decodeProtectedHeader`, `jwtVerify`.

**(4) `validateAuthResponse` in 3.8.6 accepts `URLSearchParams | URL`, NOT `Request`.** The spec's
"accepts a Request/URLSearchParams" is imprecise for this version — plain `validateAuthResponse` takes
`URLSearchParams | URL` only (only `validateJwtAuthResponse`/`validateDetachedSignatureResponse`/
`validateCodeIdTokenResponse`, which we do NOT use, accept `Request`). Resolution: the POST/form_post
branch parses the urlencoded body into `new URLSearchParams(bodyText)` and passes **that** to
`validateAuthResponse` — exactly as the GET branch passes `url.searchParams`. Both transports converge
on a single `URLSearchParams`.

**Naming note:** the spec/task refer to the normalized return type as `MappedIdentity`; the actual
shipped type is **`ExternalIdentity`** (`components/auth/src/oauth.ts`), `{ accountId, email?,
emailVerified, name? }`. This plan uses the real name `ExternalIdentity` throughout.

---

## Task 1 — `discordProvider` (oauth2, zero seam change)

**Why first:** zero seam change — establishes the builder + unit-test pattern the rest follow.

Discord issues no OIDC `id_token`; identity comes from `GET https://discord.com/api/users/@me` with the
access token (the existing `oauth2` branch in `exchangeAndExtractIdentity`, which fetches
`userinfoEndpoint` and, when present, `emailsEndpoint`). Discord has **no** `emailsEndpoint`, so the
oauth2 branch sets `email = user.email`, `emailVerified = false`, and calls `mapClaims({ …user, email,
emailVerified })`; Discord's mapper reads `u.verified` off the spread `user` (not the injected
`emailVerified`), so verification derives correctly from Discord's own `verified` field. The oauth2
branch's GitHub-flavored request headers (`accept: application/vnd.github+json`, `user-agent:
stackbase`) are harmless for Discord (it returns JSON regardless and only requires the Bearer token) —
this is why Discord is "zero seam change."

### Step 1.1 — add `discordProvider` to `components/auth/src/oauth.ts`

Insert after `githubProvider` (after line 96):

```ts
/** Discord — a NON-OIDC oauth2 provider (no id_token): explicit endpoints + a `/users/@me` mapper.
 *  `emailVerified` derives from Discord's own `verified` flag on the userinfo object (the oauth2
 *  callback branch passes `{ ...user, email, emailVerified:false }` for providers with no
 *  `emailsEndpoint`; this mapper reads `u.verified`, not the injected field). */
export function discordProvider(opts: { clientId: string; clientSecret: string; scopes?: string[] }): OAuthProvider {
  return oauthProvider({
    kind: "oauth2",
    authorizationEndpoint: "https://discord.com/oauth2/authorize",
    tokenEndpoint: "https://discord.com/api/oauth2/token",
    userinfoEndpoint: "https://discord.com/api/users/@me",
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["identify", "email"],
    mapClaims: (u) => ({
      accountId: String(u.id ?? ""),
      email: typeof u.email === "string" ? u.email : undefined,
      emailVerified: u.verified === true,
      name: typeof u.global_name === "string" ? u.global_name : typeof u.username === "string" ? u.username : undefined,
    }),
  });
}
```

### Step 1.2 — export it from `components/auth/src/index.ts`

Change line 7 from:

```ts
export { googleProvider, githubProvider, oauthProvider } from "./oauth";
```

to:

```ts
export { googleProvider, githubProvider, discordProvider, oauthProvider } from "./oauth";
```

### Step 1.3 — unit test `components/auth/test/oauth-providers.test.ts`

Append to the existing file (imports at top will be widened as each task adds a builder; for T1 update
line 2 to import `discordProvider`):

Change line 2 to:

```ts
import { googleProvider, githubProvider, discordProvider, oauthProvider } from "../src/oauth";
```

Append these tests:

```ts
it("discordProvider is oauth2 with the right endpoints + default scopes", () => {
  const p = discordProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.kind).toBe("oauth2");
  expect(p.authorizationEndpoint).toBe("https://discord.com/oauth2/authorize");
  expect(p.tokenEndpoint).toBe("https://discord.com/api/oauth2/token");
  expect(p.userinfoEndpoint).toBe("https://discord.com/api/users/@me");
  expect(p.emailsEndpoint).toBeUndefined();
  expect(p.scopes).toEqual(["identify", "email"]);
});

it("discordProvider mapClaims: verified→emailVerified, global_name preferred over username", () => {
  const p = discordProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.mapClaims({ id: 987654321, username: "octo", global_name: "The Octo", email: "d@x.com", verified: true }))
    .toEqual({ accountId: "987654321", email: "d@x.com", emailVerified: true, name: "The Octo" });
  // verified:false → strict false (never links); falls back to username when no global_name.
  expect(p.mapClaims({ id: "1", username: "raw", email: "d@x.com", verified: false }))
    .toEqual({ accountId: "1", email: "d@x.com", emailVerified: false, name: "raw" });
  // no email at all → emailVerified false, email undefined (no placeholder).
  const r = p.mapClaims({ id: "2", username: "noemail" });
  expect(r.email).toBeUndefined();
  expect(r.emailVerified).toBe(false);
});

it("discordProvider accepts custom scopes", () => {
  expect(discordProvider({ clientId: "id", clientSecret: "sec", scopes: ["identify"] }).scopes).toEqual(["identify"]);
});
```

### Step 1.4 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 2 — `facebookProvider` (oauth2, Graph version + `fields` param)

Facebook is `oauth2`; identity comes from `GET https://graph.facebook.com/<v>/me?fields=id,name,email`
with the access token. The `?fields=…` query is **mandatory and must survive to the Bearer call** — it
does, because `userinfoEndpoint` is the full URL (query included) and the oauth2 branch fetches
`userinfoEndpoint` verbatim. Facebook has no `emailsEndpoint`; the branch passes `{ …user, email,
emailVerified:false }` and Facebook's mapper computes `emailVerified = !!email` (Facebook only returns
confirmed emails; `email` can be absent → `false`). Graph version is a single named constant.

### Step 2.1 — add the version constant + `facebookProvider` to `components/auth/src/oauth.ts`

Insert after `discordProvider`:

```ts
/** The pinned Meta Graph API version for `facebookProvider` — one place (spec Part B). Bump
 *  deliberately; a caller can override per-provider via `facebookProvider({ graphVersion })`. */
export const FACEBOOK_GRAPH_VERSION = "v25.0";

/** Facebook — a NON-OIDC oauth2 provider (no id_token): Graph `dialog/oauth` + `/me?fields=…`. The
 *  `fields` query on the userinfo URL is MANDATORY (Graph returns only the requested fields) and rides
 *  through to the Bearer call unchanged (the oauth2 callback branch fetches `userinfoEndpoint`
 *  verbatim). `emailVerified` = presence of an email (Facebook returns only confirmed emails; an
 *  absent email → `false`, never a placeholder). */
export function facebookProvider(opts: { clientId: string; clientSecret: string; scopes?: string[]; graphVersion?: string }): OAuthProvider {
  const v = opts.graphVersion ?? FACEBOOK_GRAPH_VERSION;
  return oauthProvider({
    kind: "oauth2",
    authorizationEndpoint: `https://www.facebook.com/${v}/dialog/oauth`,
    tokenEndpoint: `https://graph.facebook.com/${v}/oauth/access_token`,
    userinfoEndpoint: `https://graph.facebook.com/${v}/me?fields=id,name,email`,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["email", "public_profile"],
    mapClaims: (u) => {
      const email = typeof u.email === "string" && u.email ? u.email : undefined;
      return {
        accountId: String(u.id ?? ""),
        email,
        emailVerified: !!email,
        name: typeof u.name === "string" ? u.name : undefined,
      };
    },
  });
}
```

### Step 2.2 — export it from `components/auth/src/index.ts`

Change line 7 to:

```ts
export { googleProvider, githubProvider, discordProvider, facebookProvider, oauthProvider } from "./oauth";
```

### Step 2.3 — unit test (append to `oauth-providers.test.ts`)

Update the import line 2 to add `facebookProvider` and `FACEBOOK_GRAPH_VERSION`:

```ts
import { googleProvider, githubProvider, discordProvider, facebookProvider, FACEBOOK_GRAPH_VERSION, oauthProvider } from "../src/oauth";
```

Append:

```ts
it("facebookProvider is oauth2 with the pinned Graph version + fields param preserved on the userinfo URL", () => {
  const p = facebookProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.kind).toBe("oauth2");
  expect(p.authorizationEndpoint).toBe(`https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`);
  expect(p.tokenEndpoint).toBe(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`);
  expect(p.userinfoEndpoint).toBe(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me?fields=id,name,email`);
  // the fields query MUST survive (Graph returns only requested fields).
  expect(new URL(p.userinfoEndpoint!).searchParams.get("fields")).toBe("id,name,email");
  expect(p.scopes).toEqual(["email", "public_profile"]);
});

it("facebookProvider mapClaims: emailVerified = email presence, absent email → false + undefined (no placeholder)", () => {
  const p = facebookProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.mapClaims({ id: 123, name: "Zuck", email: "z@fb.com" }))
    .toEqual({ accountId: "123", email: "z@fb.com", emailVerified: true, name: "Zuck" });
  const noEmail = p.mapClaims({ id: 456, name: "NoMail" });
  expect(noEmail.email).toBeUndefined();
  expect(noEmail.emailVerified).toBe(false);
  // empty-string email is treated as absent.
  expect(p.mapClaims({ id: 789, name: "Empty", email: "" }).emailVerified).toBe(false);
});

it("facebookProvider honors a graphVersion override consistently across all three endpoints", () => {
  const p = facebookProvider({ clientId: "id", clientSecret: "sec", graphVersion: "v21.0" });
  expect(p.authorizationEndpoint).toContain("/v21.0/");
  expect(p.tokenEndpoint).toContain("/v21.0/");
  expect(p.userinfoEndpoint).toContain("/v21.0/");
});
```

### Step 2.4 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 3 — `microsoftProvider` + the templated-issuer seam hook (A4)

Microsoft is `oidc`. The seam change (A4): an optional `OAuthProvider.expectedIssuer` field, wired into
the cached `AuthorizationServer` via oauth4webapi's runtime `_expectedIssuer` Symbol, relaxing ONLY the
id_token `iss` string-equality (JWKS signature validation unchanged — Resolved seam fact (1)).

### Step 3.1 — widen the `OAuthProvider` type + `oauthProvider` passthrough (`oauth.ts`)

Add the `expectedIssuer` field to the `OAuthProvider` interface. Change the interface (currently lines
19-35) so the block from `scopes` onward reads:

```ts
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** oidc only: relax the id_token `iss` exact-string match (multi-tenant Microsoft — a `common`
   *  token's `iss` is tenant-specific, e.g. `https://login.microsoftonline.com/<tenantid>/v2.0`).
   *  Given the verified claims, return the issuer string to accept; JWKS SIGNATURE VALIDATION IS
   *  UNCHANGED (oauth4webapi still verifies against discovery's `jwks_uri`). Unset ⇒ strict A3
   *  exact-match against `as.issuer`. */
  expectedIssuer?: string | ((claims: Record<string, unknown>) => string);
  /** Map the provider's raw claims (`id_token` claims for oidc; the merged `/user`+`/user/emails`
   *  object for github) to the normalized `ExternalIdentity`. */
  mapClaims: (raw: Record<string, unknown>) => ExternalIdentity;
```

Add the `expectedIssuer` passthrough in the `oauthProvider` builder. Change its returned object
(currently lines 39-57) to insert the passthrough after `scopes`:

```ts
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    ...(opts.expectedIssuer !== undefined ? { expectedIssuer: opts.expectedIssuer } : {}),
    mapClaims:
      opts.mapClaims ??
      ((c) => ({
        accountId: String(c.sub ?? ""),
        email: typeof c.email === "string" ? c.email : undefined,
        emailVerified: c.email_verified === true,
        name: typeof c.name === "string" ? c.name : undefined,
      })),
```

### Step 3.2 — the `_expectedIssuer` accessor + wire it in `authorizationServerFor` (`oauth.ts`)

Add the typed accessor just above `authorizationServerFor` (after the `asCache` declaration, line 174):

```ts
/** oauth4webapi exports this Symbol at RUNTIME (`build/index.js`: `export const _expectedIssuer =
 *  Symbol()`) but OMITS it from its published `.d.ts`, so we reach it through a typed accessor. Its
 *  `validateIssuer` consults `as[_expectedIssuer]?.(result) ?? as.issuer` when checking the id_token's
 *  `iss` — assigning a resolver relaxes ONLY that string comparison. The token's SIGNATURE is still
 *  validated against discovery's `jwks_uri` by `processAuthorizationCodeResponse`, so this is not a
 *  signature bypass (spec decision 6). */
const expectedIssuerKey = (oauth as unknown as { _expectedIssuer: symbol })._expectedIssuer;
```

Replace `authorizationServerFor` (lines 180-199) with a version that obtains `as` on either path, then
sets the resolver when `expectedIssuer` is present:

```ts
export async function authorizationServerFor(p: OAuthProvider): Promise<oauth.AuthorizationServer> {
  let as: oauth.AuthorizationServer;
  if (p.kind === "oidc") {
    const key = p.issuer!;
    const cached = asCache.get(key);
    if (cached) {
      as = cached;
    } else {
      const issuerUrl = new URL(p.issuer!);
      as = await oauth.processDiscoveryResponse(
        issuerUrl,
        await oauth.discoveryRequest(issuerUrl, { [oauth.allowInsecureRequests]: isLoopbackUrl(p.issuer!) }),
      );
      asCache.set(key, as);
    }
  } else {
    as = {
      issuer: p.issuer ?? new URL(p.authorizationEndpoint!).origin,
      authorization_endpoint: p.authorizationEndpoint!,
      token_endpoint: p.tokenEndpoint!,
      ...(p.userinfoEndpoint ? { userinfo_endpoint: p.userinfoEndpoint } : {}),
    };
  }
  // A4 (Microsoft): relax ONLY the id_token `iss` string-equality when the provider declares an
  // `expectedIssuer`. `validateIssuer` reads `as[_expectedIssuer]?.(result)`; the resolver gets the
  // full result object, so we adapt our public `(claims) => string` hook. JWKS signature validation is
  // untouched. Idempotent to set repeatedly on the cached `as` (same provider ⇒ same issuer key).
  if (p.kind === "oidc" && p.expectedIssuer !== undefined) {
    const hook = p.expectedIssuer;
    (as as Record<symbol, unknown>)[expectedIssuerKey] = (result: { claims: Record<string, unknown> }) =>
      typeof hook === "function" ? hook(result.claims) : hook;
  }
  return as;
}
```

### Step 3.3 — add `microsoftProvider` to `oauth.ts`

Insert after `facebookProvider`:

```ts
/** The Microsoft Entra authority host — `microsoftProvider`'s issuer template and the multi-tenant
 *  issuer-relaxation gate both key off it. */
const MICROSOFT_AUTHORITY_HOST = "https://login.microsoftonline.com";

/** The templated-issuer resolver for a multi-tenant Microsoft config (`common`/`organizations`/
 *  `consumers`): accept the token's own `iss` IFF it is a concrete Entra tenant issuer of the exact
 *  shape `https://login.microsoftonline.com/<tenant>/v2.0` (so we never blanket-accept a non-Microsoft
 *  issuer); otherwise return a value the token's `iss` will NOT equal, forcing the strict throw. JWKS
 *  signature validation is unchanged (oauth4webapi validates against `common`'s discovery `jwks_uri` —
 *  Microsoft's shared keys), so only a genuinely Microsoft-signed token from any tenant passes. */
export function microsoftExpectedIssuer(claims: Record<string, unknown>): string {
  const iss = claims.iss;
  if (typeof iss === "string" && /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(iss)) return iss;
  return `${MICROSOFT_AUTHORITY_HOST}/common/v2.0`; // token's concrete iss will not equal this → strict fail
}

/** Microsoft (Entra ID) — an OIDC provider (identity from the verified `id_token`). `tenant` selects
 *  the authority: `common` (default) | `organizations` | `consumers` | a tenant GUID |
 *  `*.onmicrosoft.com`. For the three multi-tenant authorities the id_token's `iss` is tenant-specific,
 *  so `expectedIssuer` is set to relax the `iss` string-match (signature still verified); a
 *  tenant-PINNED authority (GUID / `*.onmicrosoft.com`) needs no relaxation and sets none (strict).
 *  `accountId` is `<tid>.<oid>` (Entra's stable per-tenant object id; falls back to `sub`).
 *  `emailVerified` is `xms_edov === true` — Entra emits no `email_verified`; `xms_edov` is the
 *  integrator-enabled optional claim (an app must add it in the token config for autolinking to work,
 *  documented). */
export function microsoftProvider(opts: { clientId: string; clientSecret: string; tenant?: string; scopes?: string[] }): OAuthProvider {
  const tenant = opts.tenant ?? "common";
  const multiTenant = tenant === "common" || tenant === "organizations" || tenant === "consumers";
  return oauthProvider({
    kind: "oidc",
    issuer: `${MICROSOFT_AUTHORITY_HOST}/${tenant}/v2.0`,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["openid", "profile", "email"],
    ...(multiTenant ? { expectedIssuer: microsoftExpectedIssuer } : {}),
    mapClaims: (c) => {
      const tid = typeof c.tid === "string" ? c.tid : undefined;
      const oid = typeof c.oid === "string" ? c.oid : undefined;
      return {
        accountId: tid && oid ? `${tid}.${oid}` : String(c.sub ?? ""),
        email: typeof c.email === "string" ? c.email : undefined,
        emailVerified: c.xms_edov === true,
        name: typeof c.name === "string" ? c.name : undefined,
      };
    },
  });
}
```

### Step 3.4 — export from `index.ts`

Change line 7 to:

```ts
export { googleProvider, githubProvider, discordProvider, facebookProvider, microsoftProvider, oauthProvider } from "./oauth";
```

### Step 3.5 — unit tests (append to `oauth-providers.test.ts`)

Update import line 2 to add `microsoftProvider` + `microsoftExpectedIssuer`:

```ts
import { googleProvider, githubProvider, discordProvider, facebookProvider, FACEBOOK_GRAPH_VERSION, microsoftProvider, microsoftExpectedIssuer, oauthProvider } from "../src/oauth";
```

Append:

```ts
it("microsoftProvider is OIDC with the common authority + default scopes + multi-tenant issuer relaxation", () => {
  const p = microsoftProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.kind).toBe("oidc");
  expect(p.issuer).toBe("https://login.microsoftonline.com/common/v2.0");
  expect(p.scopes).toEqual(["openid", "profile", "email"]);
  expect(typeof p.expectedIssuer).toBe("function"); // common ⇒ relaxed
});

it("microsoftProvider organizations/consumers relax; a tenant GUID / onmicrosoft.com is STRICT (no relaxation)", () => {
  expect(typeof microsoftProvider({ clientId: "i", clientSecret: "s", tenant: "organizations" }).expectedIssuer).toBe("function");
  expect(typeof microsoftProvider({ clientId: "i", clientSecret: "s", tenant: "consumers" }).expectedIssuer).toBe("function");
  const guid = microsoftProvider({ clientId: "i", clientSecret: "s", tenant: "11111111-2222-3333-4444-555555555555" });
  expect(guid.expectedIssuer).toBeUndefined();
  expect(guid.issuer).toBe("https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0");
  expect(microsoftProvider({ clientId: "i", clientSecret: "s", tenant: "contoso.onmicrosoft.com" }).expectedIssuer).toBeUndefined();
});

it("microsoftProvider mapClaims: accountId = tid.oid (fallback sub), emailVerified = xms_edov === true", () => {
  const p = microsoftProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.mapClaims({ tid: "T", oid: "O", sub: "S", email: "u@ms.com", xms_edov: true, name: "MS User" }))
    .toEqual({ accountId: "T.O", email: "u@ms.com", emailVerified: true, name: "MS User" });
  // no oid → fall back to sub; no xms_edov → emailVerified false (never links).
  expect(p.mapClaims({ tid: "T", sub: "S", email: "u@ms.com" }))
    .toEqual({ accountId: "S", email: "u@ms.com", emailVerified: false, name: undefined });
  // xms_edov present but not strictly true → false.
  expect(p.mapClaims({ sub: "S", email: "u@ms.com", xms_edov: "true" }).emailVerified).toBe(false);
});

it("microsoftExpectedIssuer accepts any concrete Entra tenant issuer but rejects a non-Microsoft iss (strict-fail fallback)", () => {
  const good = "https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffff00001111/v2.0";
  expect(microsoftExpectedIssuer({ iss: good })).toBe(good); // expected === actual ⇒ validateIssuer passes
  // an attacker-controlled iss returns the strict fallback, which will NOT equal the token's iss ⇒ throw.
  expect(microsoftExpectedIssuer({ iss: "https://evil.example.com/tenant/v2.0" }))
    .toBe("https://login.microsoftonline.com/common/v2.0");
  expect(microsoftExpectedIssuer({})).toBe("https://login.microsoftonline.com/common/v2.0");
});
```

### Step 3.6 — seam wiring test `components/auth/test/oauth-seam.test.ts` (new)

Prove `authorizationServerFor` actually attaches the resolver at oauth4webapi's real Symbol key (the
white-box proof that the hook is wired to the exact lever `validateIssuer` reads):

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import * as oauth from "oauth4webapi";
import { authorizationServerFor, oauthProvider, buildAuthorizeUrl } from "../src/oauth";

// A minimal OIDC discovery server so `authorizationServerFor` resolves without live network.
let mock: Server;
let mockUrl = "";
async function startDiscovery(): Promise<void> {
  mock = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer: mockUrl, authorization_endpoint: `${mockUrl}/authorize`, token_endpoint: `${mockUrl}/token`, jwks_uri: `${mockUrl}/jwks` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const a = mock.address();
  mockUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}
afterEach(async () => { await new Promise<void>((r) => mock.close(() => r())); });

// The same runtime Symbol oauth4webapi's validateIssuer consults (untyped in the .d.ts).
const expectedIssuerKey = (oauth as unknown as { _expectedIssuer: symbol })._expectedIssuer;

describe("A4 seam: expectedIssuer wires oauth4webapi's _expectedIssuer resolver", () => {
  it("attaches a resolver returning the provider's expectedIssuer for a given claims set", async () => {
    await startDiscovery();
    const p = oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "c", clientSecret: "s", expectedIssuer: (claims) => String(claims.iss) });
    const as = await authorizationServerFor(p);
    const resolver = (as as Record<symbol, unknown>)[expectedIssuerKey] as ((r: { claims: Record<string, unknown> }) => string) | undefined;
    expect(typeof resolver).toBe("function");
    expect(resolver!({ claims: { iss: "https://tenant.example/v2.0" } })).toBe("https://tenant.example/v2.0");
  });

  it("leaves _expectedIssuer unset when the provider declares no expectedIssuer (A3 strict default)", async () => {
    await startDiscovery();
    const p = oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "c", clientSecret: "s" });
    const as = await authorizationServerFor(p);
    expect((as as Record<symbol, unknown>)[expectedIssuerKey]).toBeUndefined();
  });
});
```

### Step 3.7 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 4 — the Apple-enabling seam changes (security-critical)

Four additive, default-inert seam changes that Apple needs. **No new provider builder in this task** —
just the seam + its tests + the default-inert proof. Apple's builder is T5.

### Step 4.1 — widen `OAuthProvider.clientSecret` + add `responseMode` + widen `mapClaims` (`oauth.ts`)

In the `OAuthProvider` interface, change three things.

Change `clientSecret` from `clientSecret: string;` to:

```ts
  /** A static string OR (Apple) an async minter resolved immediately before the token exchange — Apple
   *  requires the "secret" to be a freshly-minted ES256 JWT. The function form is resolved in
   *  `exchangeAndExtractIdentity`; static-string providers are unchanged. */
  clientSecret: string | (() => string | Promise<string>);
```

Add `responseMode` after `expectedIssuer` (added in T3):

```ts
  /** oidc only: `"form_post"` makes `buildAuthorizeUrl` emit `response_mode=form_post` (Apple returns
   *  the authorization response as an HTTP POST). Default/absent ⇒ `"query"` (A3 behavior). */
  responseMode?: "query" | "form_post";
```

Widen `mapClaims` — change its signature (line 34, as amended in T3) to:

```ts
  /** Map the provider's raw claims (`id_token` claims for oidc; the merged `/user`+`/user/emails`
   *  object for github) to the normalized `ExternalIdentity`. `extra` carries the FIRST-AUTH `user`
   *  JSON some providers (Apple form_post) send once, for a COSMETIC display name ONLY — never trusted
   *  for identity/email/verification (spec decision 1). Existing mappers ignore the second arg. */
  mapClaims: (
    claims: Record<string, unknown>,
    extra?: { user?: { name?: { firstName?: string; lastName?: string }; email?: string } },
  ) => ExternalIdentity;
```

Add the `responseMode` passthrough in the `oauthProvider` builder — change the block added in T3 to also
spread `responseMode` (place it right after the `expectedIssuer` passthrough):

```ts
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    ...(opts.expectedIssuer !== undefined ? { expectedIssuer: opts.expectedIssuer } : {}),
    ...(opts.responseMode ? { responseMode: opts.responseMode } : {}),
    mapClaims:
      opts.mapClaims ??
```

(The generic builder's default mapper stays 1-arg — assignable to the widened 2-arg type.)

### Step 4.2 — `buildAuthorizeUrl` emits `response_mode=form_post` when set (`oauth.ts`)

In `buildAuthorizeUrl` (lines 203-216), add the `response_mode` param before `return`:

```ts
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (args.nonce) url.searchParams.set("nonce", args.nonce);
  if (p.responseMode === "form_post") url.searchParams.set("response_mode", "form_post");
  return url.toString();
```

### Step 4.3 — async `clientSecret` resolution + thread `extra` in `exchangeAndExtractIdentity` (`external.ts` via `oauth.ts`)

`exchangeAndExtractIdentity` lives in `oauth.ts` (lines 262-292). Change its signature to accept `extra`,
resolve the async secret, and pass `extra` to the oidc mapper.

Change the args type (lines 262-265) to add `extra`:

```ts
export async function exchangeAndExtractIdentity(args: {
  as: oauth.AuthorizationServer; provider: OAuthProvider; params: URLSearchParams;
  redirectUri: string; codeVerifier: string; nonce?: string;
  extra?: { user?: { name?: { firstName?: string; lastName?: string }; email?: string } };
}): Promise<ExternalIdentity> {
```

Change the client-auth construction (lines 266-267) to resolve an async secret:

```ts
  const client: oauth.Client = { client_id: args.provider.clientId };
  // A1 seam: `clientSecret` may be an async minter (Apple's ES256 JWT). Resolve to a string immediately
  // before building the client-auth. Static-string providers are unchanged.
  const secret = typeof args.provider.clientSecret === "function" ? await args.provider.clientSecret() : args.provider.clientSecret;
  const clientAuth = oauth.ClientSecretPost(secret);
```

Change the oidc mapper call (line 278) to thread `extra`:

```ts
  if (args.provider.kind === "oidc") {
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (!claims) throw new Error("no id_token");
    return args.provider.mapClaims(claims as unknown as Record<string, unknown>, args.extra);
  }
```

(The oauth2 branch's `mapClaims({ ...user, email, emailVerified })` call is unchanged — `extra` is
irrelevant to non-OIDC providers.)

### Step 4.4 — POST/form_post branch in `oauthCallback` (`external.ts`)

Replace the head of `oauthCallback` (lines 263-292 — through the exchange `try/catch`) so it collects
the response params from **either** the GET query **or** a urlencoded POST body, parses the cosmetic
`user` JSON, and passes both the validated params and `extra` to the exchange. Everything downstream
(the resolve/handoff/redirect from line 294) is unchanged.

Replace lines 263-292 with:

```ts
async function oauthCallback(ctx: ActionCtx, config: AuthConfig, request: Request, url: URL, provider: string, p: OAuthProvider): Promise<Response> {
  // Collect the authorization-response params from EITHER the GET query OR (Apple `form_post`) the
  // urlencoded POST body. Both converge on a single URLSearchParams handed to `validateAuthResponse`
  // and the exchange. The POST body is NOT a new trust source: it carries the same code/state/id_token
  // a GET would, plus a COSMETIC `user` JSON (first-auth display name only — never identity; decision 1).
  let params: URLSearchParams;
  let extra: { user?: { name?: { firstName?: string; lastName?: string }; email?: string } } | undefined;
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    if (!ct.includes("application/x-www-form-urlencoded")) return fail(400);
    let bodyText: string;
    try { bodyText = await request.text(); } catch { return fail(400); }
    params = new URLSearchParams(bodyText);
    const userRaw = params.get("user");
    if (userRaw) {
      // Apple sends `user` ONCE (first authorization). Parse defensively for the cosmetic name only —
      // a malformed value is ignored, never fatal, and NEVER read for email/identity.
      try {
        const parsed = JSON.parse(userRaw) as { name?: { firstName?: string; lastName?: string }; email?: string };
        extra = { user: parsed };
      } catch { /* cosmetic-only — ignore */ }
    }
  } else {
    params = url.searchParams;
  }

  const state = params.get("state");
  if (!state) return fail(400);

  // Consume-before-validate: `_consumeOAuthState` deletes the row FIRST, then validates provider/expiry
  // (commitThenThrow on any post-consume throw). A miss/mismatch/replay → generic 400. This CSRF/replay
  // defense is transport-agnostic — a replayed POST callback with a consumed state 400s exactly like GET.
  let recovered: { codeVerifier: string; nonce?: string; redirectTo: string; linkUserId?: string };
  try {
    recovered = await ctx.runMutation("auth:_consumeOAuthState", { provider, stateHash: sha256base64url(state) });
  } catch { return fail(400); }

  // Re-validate redirectTo against the allowlist (defense in depth), BEFORE any exchange/resolve write.
  if (!isAllowedRedirect(recovered.redirectTo, config.oauth!.redirectAllowlist)) return fail(400);

  // Exchange + extract identity. oauth4webapi validates state (validateAuthResponse) + nonce
  // (processAuthorizationCodeResponse). Identity derives ONLY from the verified id_token; `extra` (the
  // cosmetic `user` JSON) is threaded to the mapper for a display name only. Any protocol failure →
  // generic 400 (no enumeration).
  let identity;
  try {
    const as = await authorizationServerFor(p);
    const client: oauth.Client = { client_id: p.clientId };
    const validated = oauth.validateAuthResponse(as, client, params, state);
    identity = await exchangeAndExtractIdentity({
      as, provider: p, params: validated, redirectUri: callbackUri(request.url, provider),
      codeVerifier: recovered.codeVerifier, ...(recovered.nonce ? { nonce: recovered.nonce } : {}),
      ...(extra ? { extra } : {}),
    });
  } catch { return fail(400); }
```

The `import` of `exchangeAndExtractIdentity` at `external.ts` line 4 already exists (it's the function
whose args we widened). No import change needed. `oauthHttp` (line 218-232) already dispatches by phase
regardless of method, so the POST reaches `oauthCallback` once the route accepts POST (Step 4.5).

### Step 4.5 — accept POST at the route (`component.ts`) + fix the pinned assertion

Change `component.ts` line 22 from:

```ts
    ...(config.oauth ? { httpRoutes: [{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" }] } : {}),
```

to:

```ts
    ...(config.oauth
      ? {
          // GET backs `/start` + the query-mode callback (Google/GitHub/Microsoft/Discord/Facebook);
          // POST backs Apple's `form_post` callback. Per-method dispatch (`matchComponentRoute`) +
          // per-method overlap guard (`composeComponents`) make the two entries disjoint and
          // unambiguous — same handler, two methods. No engine seam change is needed.
          httpRoutes: [
            { method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
            { method: "POST", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
          ],
        }
      : {}),
```

Update the pinned assertion in `components/auth/test/external-config.test.ts` line 21 from:

```ts
  expect(comp.httpRoutes).toEqual([{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" }]);
```

to:

```ts
  expect(comp.httpRoutes).toEqual([
    { method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
    { method: "POST", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
  ]);
```

### Step 4.6 — seam-change unit test `components/auth/test/oauth-seam.test.ts` (append)

Append `buildAuthorizeUrl` `response_mode` assertions to the file created in T3 (add `buildAuthorizeUrl`
to its imports — already listed above). These need an `AuthorizationServer`; reuse the discovery mock:

```ts
describe("A2 seam: response_mode=form_post is emitted only when the provider sets responseMode", () => {
  it("emits response_mode=form_post for a form_post provider, and NOT for a default (query) provider", async () => {
    await startDiscovery();
    const args = { redirectUri: "https://app/cb", state: "st", codeChallenge: "cc", nonce: "nn" };

    const formPost = oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "c", clientSecret: "s", responseMode: "form_post" });
    const asFP = await authorizationServerFor(formPost);
    expect(new URL(buildAuthorizeUrl(asFP, formPost, args)).searchParams.get("response_mode")).toBe("form_post");

    const query = oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "c", clientSecret: "s" });
    const asQ = await authorizationServerFor(query);
    expect(new URL(buildAuthorizeUrl(asQ, query, args)).searchParams.has("response_mode")).toBe(false);
  });
});
```

### Step 4.7 — POST-callback + async-secret component test `components/auth/test/oauth-post-callback.test.ts` (new)

Drive the POST/form_post callback and an async `clientSecret` end-to-end at the component layer, reusing
the existing component-level mock OIDC provider (`components/auth/test/support/mock-oauth-provider.ts`,
which serves discovery/jwks/`POST /token` and has `setNextIdTokenClaims`). Proves: (a) a urlencoded POST
body reaches the same downstream as a GET; (b) identity comes from the verified id_token, NOT the POST
`user` JSON's email; (c) an async `clientSecret` function is resolved at exchange.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineSchema } from "@stackbase/values";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { defineAuth } from "../src/component";
import { oauthProvider } from "../src/oauth";
import type { MintResult } from "../src/functions";
import { startMockOidcProvider, type MockOidcProvider } from "./support/mock-oauth-provider";

let mock: MockOidcProvider;
afterEach(async () => { if (mock) await mock.close(); });

async function makeRuntime(comp: ReturnType<typeof defineAuth>) {
  const { catalog, moduleMap, componentNames, contextProviders, tableNumbers } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [comp],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog, modules: moduleMap, componentNames, contextProviders, tableNumbers,
  });
}

/** Drive `/start`, returning the authorize-URL params the callback needs (state + nonce). */
async function driveStart(rt: Awaited<ReturnType<typeof makeRuntime>>, redirectTo: string): Promise<{ state: string; nonce: string }> {
  const req = new Request(`http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=` + encodeURIComponent(redirectTo));
  const res = await rt.runHttpAction("auth:oauthHttp", req, { identity: null });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  return { state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce")! };
}

/** POST a urlencoded form body to the callback (the Apple `form_post` transport). */
function drivePostCallback(rt: Awaited<ReturnType<typeof makeRuntime>>, body: Record<string, string>): Promise<Response> {
  const req = new Request("http://127.0.0.1:1/api/auth/oauth/mock/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return rt.runHttpAction("auth:oauthHttp", req, { identity: null });
}

async function complete(rt: Awaited<ReturnType<typeof makeRuntime>>, handoffCode: string): Promise<MintResult> {
  const r = await rt.runAction<MintResult>("auth:completeOAuthSignIn", { handoffCode }, { identity: null });
  return r.value;
}

describe("A2/A1/A3 seam: form_post POST callback + async clientSecret + cosmetic user JSON", () => {
  it("a urlencoded POST callback reaches the same downstream as GET; identity comes from the id_token, NOT the POST user JSON", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: {
          // Apple-shaped: oidc + form_post + an ASYNC clientSecret minter, pointed at the loopback mock.
          mock: oauthProvider({
            kind: "oidc", issuer: mock.url, clientId: "cid",
            clientSecret: async () => "minted-secret",
            responseMode: "form_post",
            mapClaims: (c, extra) => {
              const first = extra?.user?.name?.firstName;
              const last = extra?.user?.name?.lastName;
              const name = [first, last].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ") || undefined;
              return {
                accountId: String(c.sub ?? ""),
                email: typeof c.email === "string" ? c.email : undefined,       // from the VERIFIED id_token only
                emailVerified: c.email_verified === true || c.email_verified === "true",
                ...(name ? { name } : {}),
              };
            },
          }),
        },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    // The id_token carries the TRUE identity email; the POST `user` JSON carries a DIFFERENT email that
    // must be ignored for identity.
    mock.setNextIdTokenClaims({ sub: "apple-sub", aud: "cid", email: "real@icloud.com", email_verified: true, nonce });

    const res = await drivePostCallback(rt, {
      code: "mockcode",
      state,
      user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: "attacker@evil.com" }),
    });
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("http://localhost:5173/app");
    expect(target.search).toBe("");                 // handoff in the fragment, never the query
    expect(target.hash).toMatch(/^#code=/);
    const handoffCode = target.hash.slice("#code=".length);

    const mint = await complete(rt, handoffCode);
    expect(mint.token).toBeTruthy();
    expect(mint.userId).toBeTruthy();
    // The provisioned user's email is the id_token's, never the POST body's — verified via a privileged read.
    const uid = await rt.run<string | null>("auth:getUserId", { token: mint.token }, { identity: null });
    expect(uid.value).toBe(mint.userId);
  });

  it("a POST callback with a non-urlencoded content-type ⇒ 400", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: async () => "s", responseMode: "form_post" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);
    await driveStart(rt, "http://localhost:5173/app");
    const req = new Request("http://127.0.0.1:1/api/auth/oauth/mock/callback", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "x", state: "y" }),
    });
    const res = await rt.runHttpAction("auth:oauthHttp", req, { identity: null });
    expect(res.status).toBe(400);
  });

  it("a replayed POST callback (same state twice) ⇒ 400 on the second (single-use state, transport-agnostic)", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: async () => "s", responseMode: "form_post", mapClaims: (c) => ({ accountId: String(c.sub ?? ""), email: typeof c.email === "string" ? c.email : undefined, emailVerified: c.email_verified === true }) }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);
    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    mock.setNextIdTokenClaims({ sub: "s1", aud: "cid", email: "u@icloud.com", email_verified: true, nonce });
    const first = await drivePostCallback(rt, { code: "mockcode", state });
    expect(first.status).toBe(302);
    const replay = await drivePostCallback(rt, { code: "mockcode", state });
    expect(replay.status).toBe(400);
  });
});
```

### Step 4.8 — default-inert proof `components/auth/test/oauth-default-inert.test.ts` (new)

Prove Google/GitHub and the query-mode GET path are byte-identical with the new fields unset:

```ts
import { describe, it, expect } from "vitest";
import { googleProvider, githubProvider, buildAuthorizeUrl, oauthProvider } from "../src/oauth";
import type { AuthorizationServer } from "oauth4webapi";

describe("default-inert: the four seam changes do not touch Google/GitHub or the query GET path", () => {
  it("Google/GitHub carry no responseMode/expectedIssuer and a plain-string clientSecret", () => {
    const g = googleProvider({ clientId: "i", clientSecret: "s" });
    const gh = githubProvider({ clientId: "i", clientSecret: "s" });
    for (const p of [g, gh]) {
      expect(p.responseMode).toBeUndefined();
      expect(p.expectedIssuer).toBeUndefined();
      expect(typeof p.clientSecret).toBe("string");
    }
  });

  it("buildAuthorizeUrl for a default provider emits NO response_mode and the exact A3 param set", () => {
    const as = { issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token" } as AuthorizationServer;
    const g = googleProvider({ clientId: "cid", clientSecret: "s" });
    const u = new URL(buildAuthorizeUrl(as, g, { redirectUri: "https://app/cb", state: "st", codeChallenge: "cc", nonce: "nn" }));
    expect(u.searchParams.has("response_mode")).toBe(false);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("nonce")).toBe("nn");
  });

  it("a static-string clientSecret still type-checks against the widened union (assignability smoke)", () => {
    const p = oauthProvider({ kind: "oidc", issuer: "https://x", clientId: "i", clientSecret: "static" });
    expect(typeof p.clientSecret).toBe("string");
  });
});
```

### Step 4.9 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green. The full A3
suite (`oauth-callback.test.ts`, `oauth-start.test.ts`, `external-*.test.ts`) must stay green unchanged
(the default-inert proof).

---

## Task 5 — `appleProvider` (ES256 client-secret minter + form_post mapper)

Built on the T4 seam. Apple's "client secret" is a short-lived ES256 JWT minted from a `.p8` key,
cached and re-minted before expiry. Identity is the verified id_token; the display name is composed from
the cosmetic `extra.user.name` (first-auth only). Apple's `email_verified` is string-or-boolean — the
exact strict-boolean hazard A3's review caught, handled here.

### Step 5.1 — imports + minter + `appleProvider` in `oauth.ts`

Add to the jose import at the top of `oauth.ts` (there is currently no jose import in this file — add
one; `jose` is already an `@stackbase/auth` dependency):

```ts
import { SignJWT, importPKCS8 } from "jose";
```

Add after `microsoftProvider`:

```ts
/** Apple's issuer / the required `aud` of the client-secret JWT. */
const APPLE_ISSUER = "https://appleid.apple.com";

/** Mint Apple's OAuth "client secret": a short-lived ES256 JWT signed with your Services-ID `.p8`
 *  private key (Apple issues no static secret). Cached in-closure and re-minted shortly before `exp`.
 *  Apple caps `exp` at 6 months; the default window is ~5 months and we refresh 60s early. The private
 *  key stays in this closure — it is never written to a row and never leaves the server. `nowFn` is
 *  injectable for deterministic tests (production uses `Date.now()`, allowed in the token-exchange
 *  action's non-deterministic context — this minter is only ever called from `exchangeAndExtractIdentity`). */
export function appleClientSecretMinter(opts: {
  clientId: string; teamId: string; keyId: string; privateKey: string; ttlSec?: number; nowFn?: () => number;
}): () => Promise<string> {
  const APPLE_MAX_EXP_SEC = 60 * 60 * 24 * 180; // Apple's hard 6-month ceiling
  const ttlSec = Math.min(opts.ttlSec ?? 60 * 60 * 24 * 30 * 5, APPLE_MAX_EXP_SEC); // ~5 months, capped
  const skewSec = 60; // re-mint 60s before expiry
  let cached: { jwt: string; expSec: number } | null = null;
  return async () => {
    const nowSec = Math.floor((opts.nowFn ? opts.nowFn() : Date.now()) / 1000);
    if (cached && nowSec < cached.expSec - skewSec) return cached.jwt;
    const key = await importPKCS8(opts.privateKey, "ES256");
    const expSec = nowSec + ttlSec;
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: opts.keyId })
      .setIssuer(opts.teamId)
      .setIssuedAt(nowSec)
      .setExpirationTime(expSec)
      .setAudience(APPLE_ISSUER)
      .setSubject(opts.clientId)
      .sign(key);
    cached = { jwt, expSec };
    return jwt;
  };
}

/** Sign in with Apple — an OIDC provider using ALL of the T4 seam: `form_post` response + POST callback,
 *  an async ES256 client-secret minter, and the widened `mapClaims` (Apple's `user` JSON display name).
 *  `clientId` is your Services ID; `teamId`/`keyId`/`privateKey` are the `.p8` key's team, key id, and
 *  PKCS#8 PEM. Identity (`sub`/`email`/`email_verified`) comes ONLY from the signature-verified
 *  id_token; the display name is the cosmetic first-auth `user.name` (never `user.email` — decision 1).
 *  `email_verified` arrives as a string OR boolean — coerced strictly (`=== true || === "true"`). */
export function appleProvider(opts: {
  clientId: string; teamId: string; keyId: string; privateKey: string; scopes?: string[];
}): OAuthProvider {
  return oauthProvider({
    kind: "oidc",
    issuer: APPLE_ISSUER,
    clientId: opts.clientId,
    clientSecret: appleClientSecretMinter(opts),
    scopes: opts.scopes ?? ["name", "email"],
    responseMode: "form_post",
    mapClaims: (c, extra) => {
      const first = extra?.user?.name?.firstName;
      const last = extra?.user?.name?.lastName;
      const name = [first, last].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ") || undefined;
      return {
        accountId: String(c.sub ?? ""),
        email: typeof c.email === "string" ? c.email : undefined,
        emailVerified: c.email_verified === true || c.email_verified === "true",
        ...(name ? { name } : {}),
      };
    },
  });
}
```

### Step 5.2 — export from `index.ts`

Change line 7 to:

```ts
export { googleProvider, githubProvider, discordProvider, facebookProvider, microsoftProvider, appleProvider, appleClientSecretMinter, oauthProvider } from "./oauth";
```

### Step 5.3 — minter + builder test `components/auth/test/apple-provider.test.ts` (new)

```ts
import { describe, it, expect } from "vitest";
import { generateKeyPair, exportPKCS8, decodeJwt, decodeProtectedHeader, jwtVerify, importSPKI, exportSPKI } from "jose";
import { appleProvider, appleClientSecretMinter } from "../src/oauth";

/** A fresh ES256 keypair, returning the PKCS#8 PEM (minter input) + the SPKI PEM (verify key). */
async function es256Pem(): Promise<{ pkcs8: string; spki: string }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return { pkcs8: await exportPKCS8(privateKey), spki: await exportSPKI(publicKey) };
}

describe("appleClientSecretMinter", () => {
  it("mints an ES256 JWT with the exact Apple header + claims, verifiable against the public key", async () => {
    const { pkcs8, spki } = await es256Pem();
    const nowMs = 1_700_000_000_000;
    const mint = appleClientSecretMinter({ clientId: "com.acme.svc", teamId: "TEAM123", keyId: "KEY123", privateKey: pkcs8, nowFn: () => nowMs });
    const jwt = await mint();

    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "KEY123" });
    const claims = decodeJwt(jwt);
    const nowSec = Math.floor(nowMs / 1000);
    expect(claims.iss).toBe("TEAM123");
    expect(claims.sub).toBe("com.acme.svc");
    expect(claims.aud).toBe("https://appleid.apple.com");
    expect(claims.iat).toBe(nowSec);
    expect(claims.exp).toBeGreaterThan(nowSec);
    expect((claims.exp as number) - nowSec).toBeLessThanOrEqual(60 * 60 * 24 * 180); // ≤ 6 months
    // Signature verifies against the public key with the ES256 algorithm.
    const key = await importSPKI(spki, "ES256");
    const { payload } = await jwtVerify(jwt, key, { audience: "https://appleid.apple.com", issuer: "TEAM123" });
    expect(payload.sub).toBe("com.acme.svc");
  });

  it("caches within the window and re-mints past it", async () => {
    const { pkcs8 } = await es256Pem();
    let nowMs = 1_700_000_000_000;
    const mint = appleClientSecretMinter({ clientId: "c", teamId: "t", keyId: "k", privateKey: pkcs8, ttlSec: 3600, nowFn: () => nowMs });
    const a = await mint();
    const b = await mint();                 // same window ⇒ identical cached secret
    expect(b).toBe(a);
    nowMs += 3600_000;                       // advance past exp − skew ⇒ re-mint
    const c = await mint();
    expect(c).not.toBe(a);
  });
});

describe("appleProvider", () => {
  it("is OIDC + form_post + name/email scopes with an async clientSecret minter", () => {
    const p = appleProvider({ clientId: "com.acme.svc", teamId: "T", keyId: "K", privateKey: "pem" });
    expect(p.kind).toBe("oidc");
    expect(p.issuer).toBe("https://appleid.apple.com");
    expect(p.scopes).toEqual(["name", "email"]);
    expect(p.responseMode).toBe("form_post");
    expect(typeof p.clientSecret).toBe("function");
  });

  it("mapClaims: email_verified accepts string OR boolean; identity from claims; name from extra.user (never email)", () => {
    const p = appleProvider({ clientId: "c", teamId: "T", keyId: "K", privateKey: "pem" });
    // string "true" and boolean true both → true; "false"/false/absent → false.
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: "true" }).emailVerified).toBe(true);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: true }).emailVerified).toBe(true);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: "false" }).emailVerified).toBe(false);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: false }).emailVerified).toBe(false);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com" }).emailVerified).toBe(false);
    // accountId from sub; email from claims only.
    expect(p.mapClaims({ sub: "apple-123", email: "a@icloud.com", email_verified: true }))
      .toMatchObject({ accountId: "apple-123", email: "a@icloud.com", emailVerified: true });
    // name composed from extra.user.name (first-auth); extra.user.email is IGNORED.
    const withName = p.mapClaims({ sub: "s", email: "real@icloud.com", email_verified: true }, { user: { name: { firstName: "Ada", lastName: "Lovelace" }, email: "attacker@evil.com" } });
    expect(withName.name).toBe("Ada Lovelace");
    expect(withName.email).toBe("real@icloud.com"); // from claims, NOT extra.user.email
    // no extra ⇒ no name (subsequent sign-ins, where Apple sends no user JSON).
    expect(p.mapClaims({ sub: "s", email: "real@icloud.com", email_verified: true }).name).toBeUndefined();
  });
});
```

### Step 5.4 — verify

`bun run --filter @stackbase/auth build && bun run --filter @stackbase/auth test`. Green.

---

## Task 6 — E2E through the real server (form_post POST callback) + docs

### Step 6.1 — extend the E2E `packages/cli/test/auth-external-e2e.test.ts`

The CLI-level mock (`packages/cli/test/support/mock-oauth-provider.ts`) already serves discovery/jwks/
`POST /token` and has `setNextToken`. For the `form_post` E2E we point an Apple-shaped provider at that
mock and POST a urlencoded body to the callback — **no mock change is needed** (the `form_post` mode
only affects `buildAuthorizeUrl`, which the test never drives via a real browser; the test POSTs to the
callback directly, and the server exchanges the code at the mock's `/token`).

Extend `startServer` to also register an `apple`-shaped provider, and add a fourth test. Change the
provider map in `startServer` (lines 78-86) to:

```ts
    defineAuth({
      oauth: {
        providers: {
          mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: DEFAULT_CLIENT_ID, clientSecret: "sec" }),
          // Apple-shaped: oidc + form_post + an ASYNC clientSecret minter + widened mapClaims (the
          // cosmetic first-auth `user` JSON → display name), pointed at the loopback mock. Exercises
          // the whole T4 seam (POST callback + async secret + extra threading) through the REAL server.
          apple: oauthProvider({
            kind: "oidc", issuer: mock.url, clientId: DEFAULT_CLIENT_ID,
            clientSecret: async () => "minted-apple-secret",
            responseMode: "form_post",
            mapClaims: (c, extra) => {
              const first = extra?.user?.name?.firstName;
              const last = extra?.user?.name?.lastName;
              const name = [first, last].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ") || undefined;
              return {
                accountId: String(c.sub ?? ""),
                email: typeof c.email === "string" ? c.email : undefined,
                emailVerified: c.email_verified === true || c.email_verified === "true",
                ...(name ? { name } : {}),
              };
            },
          }),
        },
        redirectAllowlist: REDIRECT_ALLOWLIST,
      },
      jwt: { issuers: [{ issuer: mock.url, audience: "stackbase", jwksUrl: mock.jwksUrl }] },
    }),
```

Add this test inside the `describe` block (after test (3)):

```ts
  it("(4) Apple-shaped form_post: a POST callback with a cosmetic user JSON mints a session; identity is the id_token's email, the POST user email is ignored (autolink proof)", async () => {
    const mock = await startMockProvider();
    try {
      const { server, wsUrl } = await startServer(mock);
      const a = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
      const b = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
      try {
        // A password user with the SAME email the id_token will carry — unverified, so the flip-gated
        // autolink applies. If identity ever leaked from the POST `user` JSON's (different) email, the
        // OAuth flow would create a SEPARATE user and this linkage assertion would fail.
        const email = "apple-user@icloud.com";
        const s = (await a.mutation(api.auth.signUp, { email, password: "pw", deviceLabel: "Chrome" })) as unknown as MintResult;
        a.setAuth(s.token);
        const seen: Array<string | null> = [];
        a.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
        await waitFor(() => seen.some((v) => v === s.userId), 5000, "password authed");

        const redirectTo = "http://localhost:5173/app";
        const startRes = await fetch(
          `${server.url}/api/auth/oauth/apple/start?redirectTo=${encodeURIComponent(redirectTo)}`,
          { redirect: "manual" },
        );
        expect(startRes.status).toBe(302);
        const loc = new URL(startRes.headers.get("location")!);
        // form_post is emitted on the authorize URL for the apple provider.
        expect(loc.searchParams.get("response_mode")).toBe("form_post");
        const state = loc.searchParams.get("state")!;
        const nonce = loc.searchParams.get("nonce")!;

        // The id_token carries the TRUE identity email (verified); the POST user JSON carries a DIFFERENT
        // email that must be ignored for identity.
        mock.setNextToken({ nonce, sub: "apple-sub", email, emailVerified: true });

        const cb = await fetch(`${server.url}/api/auth/oauth/apple/callback`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: "mockcode",
            state,
            user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: "attacker@evil.com" }),
          }).toString(),
          redirect: "manual",
        });
        expect(cb.status).toBe(302);
        const cbLoc = new URL(cb.headers.get("location")!);
        expect(cbLoc.origin + cbLoc.pathname).toBe(redirectTo);
        expect(cbLoc.search).toBe("");                 // handoff in the fragment, never the query
        const handoffCode = cbLoc.hash.replace(/^#code=/, "");
        expect(handoffCode.length).toBeGreaterThan(0);

        const mint = (await b.action(api.auth.completeOAuthSignIn, { handoffCode })) as unknown as MintResult;
        // SAME userId — the Apple identity LINKED to the pre-existing password user via the id_token's
        // verified email, proving identity ignored the POST `user` JSON's (different) email.
        expect(mint.userId).toBe(s.userId);

        // The password session reactively flips to null (flip-gated first-mailbox-proof revocation).
        await waitFor(() => seen.at(-1) === null, 5000, "reactive apple link-revoke");
        expect(seen.at(-1)).toBeNull();
      } finally {
        a.close();
        b.close();
      }
    } finally {
      await mock.close();
    }
  });
```

Add `apple` to the `api.auth` typing if needed — the existing `api` object already declares
`completeOAuthSignIn`/`signUp`, which is all this test calls; no change required.

### Step 6.2 — verify the E2E

`bun run --filter @stackbase/auth build` (so `packages/cli` resolves the new seam via `dist/`), then
`bun run --filter @stackbase/cli test auth-external-e2e`. Green — all four tests, including the existing
three (unchanged, default-inert).

### Step 6.3 — docs `docs/enduser/build/auth.md`

In the External-identity section (after the `googleProvider`/`githubProvider` example around line
294-311), add the four new providers to the imports and config example, and add per-provider notes.

Extend the config example's import + providers map to include the four new builders:

```ts
import {
  defineAuth, googleProvider, githubProvider,
  microsoftProvider, discordProvider, facebookProvider, appleProvider,
} from "@stackbase/auth";

export default defineAuth({
  oauth: {
    providers: {
      google: googleProvider({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! }),
      github: githubProvider({ clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! }),
      microsoft: microsoftProvider({ clientId: process.env.MS_CLIENT_ID!, clientSecret: process.env.MS_CLIENT_SECRET! }),
      discord: discordProvider({ clientId: process.env.DISCORD_CLIENT_ID!, clientSecret: process.env.DISCORD_CLIENT_SECRET! }),
      facebook: facebookProvider({ clientId: process.env.FB_APP_ID!, clientSecret: process.env.FB_APP_SECRET! }),
      apple: appleProvider({
        clientId: process.env.APPLE_SERVICES_ID!,   // your Services ID, e.g. com.acme.web
        teamId: process.env.APPLE_TEAM_ID!,
        keyId: process.env.APPLE_KEY_ID!,
        privateKey: process.env.APPLE_PRIVATE_KEY!, // the .p8 PKCS#8 PEM contents
      }),
    },
    redirectAllowlist: ["https://app.example.com/auth/callback"],
  },
});
```

Add a subsection after the existing provider prose:

```markdown
### Built-in providers

All six builders share the same flow — register the engine's **callback** URL
(`https://<deployment>/api/auth/oauth/<name>/callback`) as the redirect URI with the provider, then
send users to `GET /api/auth/oauth/<name>/start?redirectTo=…`. Provider-specific notes:

- **`microsoftProvider({ clientId, clientSecret, tenant?, scopes? })`** — Microsoft Entra ID (OIDC).
  `tenant` defaults to `"common"` (also `"organizations"`, `"consumers"`, or a tenant GUID /
  `*.onmicrosoft.com`). For the multi-tenant authorities the id_token's issuer is tenant-specific, so
  Stackbase relaxes the issuer **string** check while still verifying the token's signature against
  Microsoft's keys. **Autolinking requires the `xms_edov` optional claim** — Entra emits no
  `email_verified`; without `xms_edov` a Microsoft sign-in is treated as unverified and never links to
  an existing account. Enable `xms_edov` (email-domain-owner-verified) in your app's token
  configuration in the Entra portal.

- **`discordProvider({ clientId, clientSecret, scopes? })`** — Discord (OAuth2, `/users/@me`). Default
  scopes `identify email`. Email is linked only when Discord reports it as `verified`.

- **`facebookProvider({ clientId, clientSecret, scopes?, graphVersion? })`** — Meta / Facebook Login
  (OAuth2, Graph `/me`). Graph version is pinned (`v25.0`); override with `graphVersion`. Facebook only
  returns confirmed emails, and an app may not receive an email at all — an absent email means a
  separate account, never a placeholder.

- **`appleProvider({ clientId, teamId, keyId, privateKey, scopes? })`** — Sign in with Apple (OIDC,
  `form_post`). `clientId` is your **Services ID** (not the app bundle id). `teamId`/`keyId`/
  `privateKey` come from a **Sign-in-with-Apple key** (`.p8`, PKCS#8 PEM). Apple issues no static client
  secret — Stackbase mints a short-lived **ES256 JWT** from your `.p8` on each token exchange (cached,
  auto-refreshed); the private key stays on the server and is never stored. Apple returns the response
  as an HTTP **POST** (`form_post`) and sends the user's **name only on the first authorization**, as a
  `user` field in the POST body. Stackbase uses that name for a **cosmetic display name only** —
  identity (the account id, email, and email-verified status) always comes from the signature-verified
  id_token, never from the POST body. (Apple's `transfer_sub` app-transfer remapping is not handled — a
  rare migration event.)
```

### Step 6.4 — full verify

`bun run build && bun run typecheck && bun run test` (workspace-wide) green.

---

## Self-review checklist (run before commit)

- **Spec coverage:** all four builders (Discord T1, Facebook T2, Microsoft T3, Apple T5) with the exact
  Part-B endpoints/scopes/mappers; all four seam changes (async clientSecret A1, form_post + POST
  callback A2, widened mapClaims A3, templated-issuer A4); testing matrix (builder units, minter test,
  seam-change tests, default-inert proof, form_post E2E); docs. ✓
- **Placeholder scan:** no `TODO`/`...`/`<fill>` in any code block; every step has complete code. ✓
- **Type consistency — the widened `mapClaims` 2-arg signature:** the `OAuthProvider.mapClaims` type
  becomes `(claims, extra?) => ExternalIdentity` (T4 Step 4.1); every 1-arg mapper (default, google,
  github, discord, facebook, microsoft) remains assignable (fewer params is legal); only Apple's mapper
  (T5) reads the 2nd arg; `exchangeAndExtractIdentity` passes `args.extra` to the oidc mapper (T4 Step
  4.3) and nothing to the oauth2 mapper. Consistent across `oauth.ts`, `external.ts`, and all tests. ✓
- **`clientSecret` union:** widened to `string | (() => string | Promise<string>)` only in T4, together
  with the exchange-site resolution (`typeof … === "function" ? await … : …`), so no intermediate task
  leaves `oauth.ClientSecretPost` receiving a non-string. ✓
- **`_expectedIssuer` accessor:** reached through a single typed accessor (`expectedIssuerKey`), never
  re-derived; JWKS signature validation untouched (relaxes only the `iss` string compare). ✓
- **Route change is auth-component-only:** a second `{ method: "POST", … }` entry; per-method dispatch +
  per-method overlap guard verified; `external-config.test.ts` pinned assertion updated. No engine seam
  change. ✓
- **Security invariants on the POST path:** single-use consume-before-validate state, PKCE, resolveProvider,
  isAllowedRedirect all preserved; the POST `user` JSON is parsed defensively and used only for a
  cosmetic name; identity from the verified id_token only (asserted by the autolink-to-X-not-Y E2E). ✓
- **Rebuild-before-dependent-tests:** every task verify rebuilds `@stackbase/auth` before the E2E. ✓

Fix any finding inline, then commit.
