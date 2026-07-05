/**
 * OAuth provider registry (spec Part 1). A provider config is a plain object so a new provider is a
 * config entry, not a code change — only google + github ship built-in; the seam (`oauthProvider`)
 * is public. `oauth4webapi` protocol wiring lives in the callback/start httpAction (Tasks 3/5); this
 * file is pure config + claim-mapping (unit-testable, no network).
 */
import * as oauth from "oauth4webapi";
import { SignJWT, importPKCS8 } from "jose";

/** The normalized identity both the OAuth callback and `signInWithIdToken` produce and hand to the
 *  shared Part-3 resolution mutation. `emailVerified` is a hard boolean (an unverified/absent email
 *  never autolinks — see `_resolveExternalIdentity`). */
export interface ExternalIdentity {
  accountId: string;   // the provider's stable subject id (google `sub`, github numeric id as string)
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export interface OAuthProvider {
  /** "oidc" → discover endpoints + verify an `id_token`; "oauth2" → explicit endpoints + userinfo. */
  kind: "oidc" | "oauth2";
  /** oidc: the discovery issuer (`.well-known/openid-configuration` is fetched from it). */
  issuer?: string;
  /** oauth2: explicit endpoints (github issues no id_token, has no discovery doc). */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  emailsEndpoint?: string;
  clientId: string;
  /** A static string OR (Apple) an async minter resolved immediately before the token exchange — Apple
   *  requires the "secret" to be a freshly-minted ES256 JWT. The function form is resolved in
   *  `exchangeAndExtractIdentity`; static-string providers are unchanged. */
  clientSecret: string | (() => string | Promise<string>);
  scopes: string[];
  /** oidc only: relax the id_token `iss` exact-string match (multi-tenant Microsoft — a `common`
   *  token's `iss` is tenant-specific, e.g. `https://login.microsoftonline.com/<tenantid>/v2.0`).
   *  Given the decoded claims, return the issuer string to accept. This hook touches ONLY the
   *  `validateIssuer` string-equality step of oauth4webapi's existing validation pipeline — it does not
   *  add, remove, or otherwise change any other check in that pipeline, and composes with (does not
   *  substitute for) `exchangeAndExtractIdentity`'s id_token JWS signature verification (see
   *  `authorizationServerFor`'s `expectedIssuerKey` note) — signature verification is what makes the
   *  class of tokens this hook widens acceptance of actually safe to accept. Unset ⇒ strict A3
   *  exact-match against `as.issuer`. */
  expectedIssuer?: string | ((claims: Record<string, unknown>) => string);
  /** oidc only: `"form_post"` makes `buildAuthorizeUrl` emit `response_mode=form_post` (Apple returns
   *  the authorization response as an HTTP POST). Default/absent ⇒ `"query"` (A3 behavior). */
  responseMode?: "query" | "form_post";
  /** Map the provider's raw claims (`id_token` claims for oidc; the merged `/user`+`/user/emails`
   *  object for github) to the normalized `ExternalIdentity`. `extra` carries the FIRST-AUTH `user`
   *  JSON some providers (Apple form_post) send once, for a COSMETIC display name ONLY — never trusted
   *  for identity/email/verification (spec decision 1). Existing mappers ignore the second arg. */
  mapClaims: (
    claims: Record<string, unknown>,
    extra?: { user?: { name?: { firstName?: string; lastName?: string }; email?: string } },
  ) => ExternalIdentity;
}

/** Generic builder — the public seam for custom providers (and what the E2E uses with a mock issuer). */
export function oauthProvider(opts: Partial<OAuthProvider> & Pick<OAuthProvider, "kind" | "clientId" | "clientSecret">): OAuthProvider {
  return {
    kind: opts.kind,
    issuer: opts.issuer,
    authorizationEndpoint: opts.authorizationEndpoint,
    tokenEndpoint: opts.tokenEndpoint,
    userinfoEndpoint: opts.userinfoEndpoint,
    emailsEndpoint: opts.emailsEndpoint,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    ...(opts.expectedIssuer !== undefined ? { expectedIssuer: opts.expectedIssuer } : {}),
    ...(opts.responseMode ? { responseMode: opts.responseMode } : {}),
    mapClaims:
      opts.mapClaims ??
      ((c) => ({
        accountId: String(c.sub ?? ""),
        email: typeof c.email === "string" ? c.email : undefined,
        emailVerified: c.email_verified === true,
        name: typeof c.name === "string" ? c.name : undefined,
      })),
  };
}

/** Google — an OIDC provider (identity from the verified `id_token`). */
export function googleProvider(opts: { clientId: string; clientSecret: string; scopes?: string[] }): OAuthProvider {
  return oauthProvider({
    kind: "oidc",
    issuer: "https://accounts.google.com",
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    mapClaims: (c) => ({
      accountId: String(c.sub ?? ""),
      email: typeof c.email === "string" ? c.email : undefined,
      emailVerified: c.email_verified === true,
      name: typeof c.name === "string" ? c.name : undefined,
    }),
  });
}

/** GitHub — a NON-OIDC provider (no id_token): explicit endpoints + a `/user`+`/user/emails` mapper.
 *  `mapClaims` receives the merged object `{ ...user, email, emailVerified }` the callback assembles. */
export function githubProvider(opts: { clientId: string; clientSecret: string; scopes?: string[] }): OAuthProvider {
  return oauthProvider({
    kind: "oauth2",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userinfoEndpoint: "https://api.github.com/user",
    emailsEndpoint: "https://api.github.com/user/emails",
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scopes: opts.scopes ?? ["read:user", "user:email"],
    mapClaims: (u) => ({
      accountId: String(u.id ?? ""),
      email: typeof u.email === "string" ? u.email : undefined,
      emailVerified: u.emailVerified === true,
      name: typeof u.name === "string" ? u.name : typeof u.login === "string" ? u.login : undefined,
    }),
  });
}

/** A request-time endpoint is loopback iff its hostname is `127.0.0.1`, `localhost`, or the IPv6
 *  loopback `::1`. `URL#hostname` always serializes an IPv6 host WITH brackets (e.g.
 *  `new URL("http://[::1]:8080").hostname === "[::1]"`, never the bare `"::1"`), so the bracketed
 *  form is what's actually compared; the bracket-stripped form is also accepted for robustness. This
 *  is the ONLY signal that ever permits `http://` — there is no app-settable "allow insecure" flag
 *  anywhere in the public `defineAuth({ oauth })` surface. Every comparison is exact hostname
 *  equality (never substring/regex) — a MITM-bypass host like `127.0.0.1.evil.com`,
 *  `localhost.evil.com`, `http://127.0.0.1@evil.com` (userinfo), or `http://evil.com#127.0.0.1`
 *  (fragment) all parse to a hostname that is NOT one of these exact strings and stay rejected. Used
 *  both at config-resolution time (`assertProviderEndpointsSecure`, reject-at-config) and at request
 *  time (Task 3/5's `allowInsecureForUrl`, to derive oauth4webapi's `allowInsecureRequests` option for
 *  the exact endpoint being hit) — same predicate, two call sites. */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** A readable alias over `isLoopbackUrl` for the request-time call sites (Task 3's discovery/JWKS
 *  fetch, Task 5's token exchange): derives oauth4webapi's `[oauth.allowInsecureRequests]` option
 *  from the URL actually being requested. Same predicate, never reimplemented. */
export function allowInsecureForUrl(url: string): boolean {
  return isLoopbackUrl(url);
}

/** Shared MITM guard for a single endpoint URL: reject a non-loopback `http://` URL, accept `https://`
 *  and loopback `http://` (127.0.0.1/localhost/::1). This is the ONE place the actual check lives —
 *  `assertProviderEndpointsSecure` below (OAuth) and the third-party-JWT issuer/JWKS-URL guard in
 *  `config.ts` (`resolveAuthConfig`'s jwt branch) both call this rather than reimplementing it, so the
 *  MITM gate can never drift between the two config surfaces. `label` is folded into the thrown
 *  message only (e.g. `oauth provider "google": issuer` or `jwt issuer[0].jwksUrl`). */
export function assertUrlIsSecure(label: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL: ${value}`);
  }
  if (parsed.protocol === "http:" && !isLoopbackUrl(value)) {
    throw new Error(
      `${label} is a non-loopback http:// endpoint (${value}) — a plain-http endpoint is a MITM vector. ` +
        `Use https://, or a loopback host (127.0.0.1/localhost/::1) for local testing.`,
    );
  }
}

/** Config-time MITM guard (spec-amended security requirement): a plain-http OAuth issuer/endpoint is
 *  a MITM vector — a path attacker could forge the token/id_token in transit. `https://` is always
 *  fine. `http://` is tolerated ONLY when the endpoint's own host is loopback (local testing / the
 *  E2E mock) — a non-loopback `http://` endpoint is REJECTED here, at `resolveOAuthConfig` time,
 *  before the provider is ever reachable, so a production deployment cannot weaken itself by
 *  pointing a provider at a public http:// URL. Checks every endpoint field the provider actually
 *  sets (both oidc's `issuer` and oauth2's explicit endpoints — a custom `oauthProvider()` call may
 *  set either shape). */
export function assertProviderEndpointsSecure(name: string, provider: OAuthProvider): void {
  const endpoints: Array<[string, string | undefined]> = [
    ["issuer", provider.issuer],
    ["authorizationEndpoint", provider.authorizationEndpoint],
    ["tokenEndpoint", provider.tokenEndpoint],
    ["userinfoEndpoint", provider.userinfoEndpoint],
    ["emailsEndpoint", provider.emailsEndpoint],
  ];
  for (const [field, value] of endpoints) {
    if (!value) continue;
    assertUrlIsSecure(`oauth provider "${name}": ${field}`, value);
  }
}

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

/** The Microsoft Entra authority host — `microsoftProvider`'s issuer template and the multi-tenant
 *  issuer-relaxation gate both key off it. */
const MICROSOFT_AUTHORITY_HOST = "https://login.microsoftonline.com";

/** The templated-issuer resolver for a multi-tenant Microsoft config (`common`/`organizations`/
 *  `consumers`): accept the token's own `iss` IFF it is a concrete Entra tenant issuer of the exact
 *  shape `https://login.microsoftonline.com/<tenant>/v2.0` (so we never blanket-accept a non-Microsoft
 *  issuer); otherwise return a value the token's `iss` will NOT equal, forcing the strict throw. This
 *  is a shape/pattern check on the CLAIMS ONLY — it narrows which `iss` values the relaxation accepts;
 *  by itself, a string-shape check like this would be necessary but not SUFFICIENT (nothing here stops
 *  a wrong-tenant, wrong-key-signed token whose `iss` merely matches the pattern). What makes the
 *  relaxation actually safe is that `exchangeAndExtractIdentity` cryptographically verifies the
 *  id_token's JWS signature against the AS's `jwks_uri` (see `authorizationServerFor`'s
 *  `expectedIssuerKey` note) for EVERY oidc provider, composing with this string check — a token whose
 *  `iss` shape-matches but is signed by the wrong key/tenant is rejected at the signature step. */
export function microsoftExpectedIssuer(claims: Record<string, unknown>): string {
  const iss = claims.iss;
  if (typeof iss === "string" && /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(iss)) return iss;
  return `${MICROSOFT_AUTHORITY_HOST}/common/v2.0`; // token's concrete iss will not equal this → strict fail
}

/** Microsoft (Entra ID) — an OIDC provider (identity from the verified `id_token`). `tenant` selects
 *  the authority: `common` (default) | `organizations` | `consumers` | a tenant GUID |
 *  `*.onmicrosoft.com`. For the three multi-tenant authorities the id_token's `iss` is tenant-specific,
 *  so `expectedIssuer` is set to relax the `iss` string-match — a purely string-level check, unrelated
 *  to signature verification (see the ⚠️ note on `expectedIssuerKey`); a tenant-PINNED authority (GUID /
 *  `*.onmicrosoft.com`) needs no relaxation and sets none (strict).
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

// ─────────────────────────── protocol helpers (Task 3) ───────────────────────────

/** Per-issuer discovery cache — an OIDC `AuthorizationServer` is fetched once per process. */
const asCache = new Map<string, oauth.AuthorizationServer>();

/** oauth4webapi's `validateIssuer` consults `as[_expectedIssuer]?.(result) ?? as.issuer` when checking
 *  the id_token's `iss` — assigning a resolver here relaxes ONLY that string comparison; it adds no
 *  other check and removes no other check from the pipeline `validateJwt`/`validatePresence`/
 *  `validateIssuer`/`validateAudience` already run.
 *
 *  ⚠️  UPDATE (Task 3.5): oauth4webapi's Authorization Code flow is decode-only BY DEFAULT —
 *  `validateJwt` only decodes and shape-checks the header/claims (exp/iat/nbf/aud/iss types), and
 *  neither `processAuthorizationCodeResponse` nor `getValidatedIdTokenClaims` itself fetches `jwks_uri`
 *  or checks the signature. THIS CODEBASE NO LONGER RELIES ON THAT DEFAULT: `exchangeAndExtractIdentity`
 *  (this file) explicitly calls the separate `oauth.validateApplicationLevelSignature` step against the
 *  AS's `jwks_uri` for EVERY oidc provider (google, microsoft, apple, and any future one), right after
 *  `processAuthorizationCodeResponse` and before the claims are trusted — a missing `jwks_uri` throws
 *  rather than silently skipping verification. So the id_token's JWS signature IS cryptographically
 *  verified for every OIDC provider, in addition to (not instead of) the TLS back-channel the token
 *  endpoint is fetched over. `expectedIssuer` only ever touches the `iss` string-equality step of this
 *  pipeline and composes WITH the signature check (it does not weaken or bypass it) — see
 *  `microsoftExpectedIssuer`'s doc comment for why signature verification is what makes that relaxation
 *  actually safe.
 *
 *  ⚠️  `_expectedIssuer` is an UNDOCUMENTED oauth4webapi@3.8.6 INTERNAL: exported at runtime from
 *  `build/index.js` but OMITTED from the published `.d.ts`, so we reach it through a cast. This is safe
 *  ONLY because `components/auth/package.json` pins `oauth4webapi` to EXACT `3.8.6`. If a future bump
 *  removes/renames it, the cast would yield `undefined` and Microsoft multi-tenant relaxation would
 *  silently degrade to strict matching (mysterious "issuer mismatch" at login). The assertion below
 *  converts that structural break into a loud, self-describing error at module load — the signal to
 *  re-verify the internal against the new version (or find its replacement). */
const maybeExpectedIssuerKey = (oauth as unknown as { _expectedIssuer?: symbol })._expectedIssuer;
if (typeof maybeExpectedIssuerKey !== "symbol") {
  throw new Error(
    "oauth4webapi internal `_expectedIssuer` Symbol is missing — Microsoft multi-tenant issuer " +
      "relaxation cannot be applied. This is an undocumented internal of the pinned oauth4webapi@3.8.6; " +
      "check the installed oauth4webapi version and re-verify the internal (components/auth/src/oauth.ts).",
  );
}
/** Re-bound with an EXPLICIT `symbol` annotation so every later use (including inside
 *  `authorizationServerFor`'s closure) is unconditionally `symbol` — no reliance on control-flow
 *  narrowing of a module-scope const flowing into a nested function body (which is not guaranteed across
 *  TS versions). The guard above has already proven it is a symbol. */
const expectedIssuerKey: symbol = maybeExpectedIssuerKey;

/** Resolve the `AuthorizationServer` for a provider: OIDC → discovery (cached); oauth2 → an explicit
 *  literal from the provider's endpoints. Insecure-http is DERIVED per-URL via the shared
 *  `isLoopbackUrl` predicate (loopback-only) — never a flag; a public http:// endpoint was already
 *  rejected in `resolveOAuthConfig` (`assertProviderEndpointsSecure`). */
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
  // full result object, so we adapt our public `(claims) => string` hook. This touches only that one
  // string-comparison step of the pipeline (see the ⚠️ note above `expectedIssuerKey` re: what this
  // pipeline does and does not verify). Idempotent to set repeatedly on the cached `as` (same provider
  // ⇒ same issuer key).
  if (p.kind === "oidc" && p.expectedIssuer !== undefined) {
    const hook = p.expectedIssuer;
    (as as unknown as Record<symbol, unknown>)[expectedIssuerKey] = (result: { claims: Record<string, unknown> }) =>
      typeof hook === "function" ? hook(result.claims) : hook;
  }
  return as;
}

/** Build the provider authorization URL (oauth4webapi ships no builder — construct it, as the panva
 *  examples do). `nonce` only for OIDC. */
export function buildAuthorizeUrl(as: oauth.AuthorizationServer, p: OAuthProvider, args: {
  redirectUri: string; state: string; codeChallenge: string; nonce?: string;
}): string {
  const url = new URL(as.authorization_endpoint!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (args.nonce) url.searchParams.set("nonce", args.nonce);
  if (p.responseMode === "form_post") url.searchParams.set("response_mode", "form_post");
  return url.toString();
}

/** Exact origin + path-prefix allowlist match (open-redirect guard). Rejects on any parse failure.
 *  The path match requires a segment boundary — a raw `startsWith` would let an allowlisted
 *  "https://app.com/app" match "https://app.com/app-evil-sibling/phish" (same origin, but the
 *  allowlist entry was meant to scope to the `/app` subtree, not any path that merely shares its
 *  prefix as a string). Exact-path match is also accepted (so a bare "/app" entry still matches
 *  "/app" itself, not only "/app/..."). */
export function isAllowedRedirect(redirectTo: string, allowlist: string[]): boolean {
  let target: URL;
  try { target = new URL(redirectTo); } catch { return false; }
  return allowlist.some((allowed) => {
    let a: URL;
    try { a = new URL(allowed); } catch { return false; }
    if (a.origin !== target.origin) return false;
    if (target.pathname === a.pathname) return true;
    const prefix = a.pathname.endsWith("/") ? a.pathname : a.pathname + "/";
    return target.pathname.startsWith(prefix);
  });
}

/** Resolve a URL-derived provider name against the configured provider map, guarding against
 *  prototype-pollution lookups (`__proto__`, `constructor`, `hasOwnProperty`, `toString`, ...) — a
 *  plain `providers[name]` index returns a truthy `Object.prototype` member for those names instead
 *  of `undefined`, which would let a malformed URL slip past the `if (!p) return fail(404)` guard
 *  and crash deeper in the flow (e.g. `new URL(p.authorizationEndpoint!)` on `undefined`), leaking
 *  an internal error where a clean 404 was intended. Shared by both the `/start` (Task 3) and
 *  `/callback` (Task 5) phases so the guard exists in exactly one place. */
export function resolveProvider(providers: Record<string, OAuthProvider>, name: string): OAuthProvider | undefined {
  if (!Object.prototype.hasOwnProperty.call(providers, name)) return undefined;
  return providers[name];
}

/** The engine callback URL for a provider — the `redirect_uri` registered with the provider and used
 *  identically at `/start` and token exchange (they MUST match). Derived from the inbound request's
 *  own origin so it works under any host/port without extra config. */
export function callbackUri(requestUrl: string, provider: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}/api/auth/oauth/${provider}/callback`;
}

// ─────────────────────────── token exchange + identity extraction (Task 5) ───────────────────────────

/** Exchange the callback code for tokens and produce the normalized `ExternalIdentity`. OIDC → verify
 *  the id_token (nonce-bound) and map its claims; oauth2 (github) → fetch `/user` + `/user/emails`
 *  with the access token and map the merged object. Throws on any protocol failure (caller → generic). */
export async function exchangeAndExtractIdentity(args: {
  as: oauth.AuthorizationServer; provider: OAuthProvider; params: URLSearchParams;
  redirectUri: string; codeVerifier: string; nonce?: string;
  extra?: { user?: { name?: { firstName?: string; lastName?: string }; email?: string } };
}): Promise<ExternalIdentity> {
  const client: oauth.Client = { client_id: args.provider.clientId };
  // A1 seam: `clientSecret` may be an async minter (Apple's ES256 JWT). Resolve to a string immediately
  // before building the client-auth. Static-string providers are unchanged.
  const secret = typeof args.provider.clientSecret === "function" ? await args.provider.clientSecret() : args.provider.clientSecret;
  const clientAuth = oauth.ClientSecretPost(secret);
  const resp = await oauth.authorizationCodeGrantRequest(
    args.as, client, clientAuth, args.params, args.redirectUri, args.codeVerifier,
    { [oauth.allowInsecureRequests]: allowInsecureForUrl(args.as.token_endpoint!) },
  );
  const result = await oauth.processAuthorizationCodeResponse(args.as, client, resp,
    args.nonce ? { expectedNonce: args.nonce } : {});

  if (args.provider.kind === "oidc") {
    // id_token JWS signature verification against the AS jwks_uri. oauth4webapi's
    // processAuthorizationCodeResponse is decode-only (OIDC §3.1.3.7 defers to the TLS
    // back-channel); we verify explicitly because the Apple form_post path delivers the
    // id_token via a browser POST where the TLS-back-channel exemption does NOT apply, and
    // as defense-in-depth for all OIDC providers. `resp` (the RAW token-endpoint Response),
    // not `result` — validateApplicationLevelSignature keys off a WeakMap set on resp.
    if (!args.as.jwks_uri) throw new Error("OIDC provider discovery returned no jwks_uri — cannot verify id_token signature");
    await oauth.validateApplicationLevelSignature(args.as, resp, {
      [oauth.allowInsecureRequests]: allowInsecureForUrl(args.as.jwks_uri),
    });
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (!claims) throw new Error("no id_token");
    return args.provider.mapClaims(claims as unknown as Record<string, unknown>, args.extra);
  }
  // github (oauth2): fetch /user + /user/emails with the access token.
  const accessToken = result.access_token;
  const ghHeaders = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "helipod" };
  const user = (await (await fetch(args.provider.userinfoEndpoint!, { headers: ghHeaders })).json()) as Record<string, unknown>;
  let email = typeof user.email === "string" ? (user.email as string) : undefined;
  let emailVerified = false;
  if (args.provider.emailsEndpoint) {
    const emails = (await (await fetch(args.provider.emailsEndpoint, { headers: ghHeaders })).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (primary) { email = primary.email; emailVerified = true; }
  }
  return args.provider.mapClaims({ ...user, email, emailVerified });
}
