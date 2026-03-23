/**
 * OAuth provider registry (spec Part 1). A provider config is a plain object so a new provider is a
 * config entry, not a code change — only google + github ship built-in; the seam (`oauthProvider`)
 * is public. `oauth4webapi` protocol wiring lives in the callback/start httpAction (Tasks 3/5); this
 * file is pure config + claim-mapping (unit-testable, no network).
 */
import * as oauth from "oauth4webapi";

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
  clientSecret: string;
  scopes: string[];
  /** Map the provider's raw claims (`id_token` claims for oidc; the merged `/user`+`/user/emails`
   *  object for github) to the normalized `ExternalIdentity`. */
  mapClaims: (raw: Record<string, unknown>) => ExternalIdentity;
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
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`oauth provider "${name}": ${field} is not a valid URL: ${value}`);
    }
    if (parsed.protocol === "http:" && !isLoopbackUrl(value)) {
      throw new Error(
        `oauth provider "${name}": ${field} is a non-loopback http:// endpoint (${value}) — a plain-http ` +
          `OAuth issuer is a MITM vector. Use https://, or a loopback host (127.0.0.1/localhost/::1) for local testing.`,
      );
    }
  }
}

// ─────────────────────────── protocol helpers (Task 3) ───────────────────────────

/** Per-issuer discovery cache — an OIDC `AuthorizationServer` is fetched once per process. */
const asCache = new Map<string, oauth.AuthorizationServer>();

/** Resolve the `AuthorizationServer` for a provider: OIDC → discovery (cached); oauth2 → an explicit
 *  literal from the provider's endpoints. Insecure-http is DERIVED per-URL via the shared
 *  `isLoopbackUrl` predicate (loopback-only) — never a flag; a public http:// endpoint was already
 *  rejected in `resolveOAuthConfig` (`assertProviderEndpointsSecure`). */
export async function authorizationServerFor(p: OAuthProvider): Promise<oauth.AuthorizationServer> {
  if (p.kind === "oidc") {
    const key = p.issuer!;
    const cached = asCache.get(key);
    if (cached) return cached;
    const issuerUrl = new URL(p.issuer!);
    const as = await oauth.processDiscoveryResponse(
      issuerUrl,
      await oauth.discoveryRequest(issuerUrl, { [oauth.allowInsecureRequests]: isLoopbackUrl(p.issuer!) }),
    );
    asCache.set(key, as);
    return as;
  }
  return {
    issuer: p.issuer ?? new URL(p.authorizationEndpoint!).origin,
    authorization_endpoint: p.authorizationEndpoint!,
    token_endpoint: p.tokenEndpoint!,
    ...(p.userinfoEndpoint ? { userinfo_endpoint: p.userinfoEndpoint } : {}),
  };
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
