/**
 * OAuth provider registry (spec Part 1). A provider config is a plain object so a new provider is a
 * config entry, not a code change — only google + github ship built-in; the seam (`oauthProvider`)
 * is public. `oauth4webapi` protocol wiring lives in the callback/start httpAction (Tasks 3/5); this
 * file is pure config + claim-mapping (unit-testable, no network).
 */

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
