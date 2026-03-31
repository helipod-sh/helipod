import { describe, it, expect } from "vitest";
import { defineAuth } from "../src/component";
import { makeAuthModules } from "../src/functions";
import { resolveAuthConfig } from "../src/config";
import { googleProvider, oauthProvider, isLoopbackUrl } from "../src/oauth";
import { consoleEmail } from "../src/email/provider";

const A1_KEYS = ["signUp","signIn","signOut","getUserId","refresh","signInAnonymously","listSessions","revokeSession","revokeOtherSessions"].sort();

it("no oauth/jwt ⇒ surface stays exactly A1 (+A2 when email present); no httpRoutes", () => {
  expect(Object.keys(makeAuthModules(resolveAuthConfig())).sort()).toEqual(A1_KEYS);
  expect(defineAuth().httpRoutes).toBeUndefined();
});

it("oauth present ⇒ A3 OAuth modules + the httpRoutes declaration are registered", () => {
  const cfg = resolveAuthConfig({ oauth: { providers: { google: googleProvider({ clientId: "i", clientSecret: "s" }) }, redirectAllowlist: ["http://localhost:5173"] } });
  const keys = Object.keys(makeAuthModules(cfg));
  for (const k of ["oauthHttp", "completeOAuthSignIn", "_startOAuth", "_consumeOAuthState", "_resolveExternalIdentity", "_consumeHandoff"]) expect(keys).toContain(k);
  expect(keys).not.toContain("signInWithIdToken");   // jwt absent
  const comp = defineAuth({ oauth: { providers: { google: googleProvider({ clientId: "i", clientSecret: "s" }) }, redirectAllowlist: ["http://localhost:5173"] } });
  expect(comp.httpRoutes).toEqual([
    { method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
    { method: "POST", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" },
  ]);
});

it("jwt present ⇒ signInWithIdToken registered (+ shared _resolveExternalIdentity); no OAuth routes", () => {
  const cfg = resolveAuthConfig({ jwt: { issuers: [{ issuer: "https://issuer", audience: "aud" }] } });
  const keys = Object.keys(makeAuthModules(cfg));
  expect(keys).toContain("signInWithIdToken");
  expect(keys).toContain("_resolveExternalIdentity");
  expect(keys).not.toContain("oauthHttp");
  expect(defineAuth({ jwt: { issuers: [{ issuer: "https://issuer", audience: "aud" }] } }).httpRoutes).toBeUndefined();
});

it("oauth without redirectAllowlist throws", () => {
  expect(() => resolveAuthConfig({ oauth: { providers: {}, redirectAllowlist: [] } })).toThrow(/redirectAllowlist/);
});

it("a non-loopback http:// provider endpoint is REJECTED at config time (MITM guard); loopback + https are allowed", () => {
  const allow = ["http://localhost:5173"];
  // Public http:// issuer → refused (a prod app can't weaken itself; there is no allow-insecure flag).
  expect(() => resolveAuthConfig({ oauth: { providers: { bad: oauthProvider({ kind: "oidc", issuer: "http://issuer.example.com", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }))
    .toThrow(/non-loopback http/);
  // A non-loopback http token endpoint on an oauth2 provider → refused too.
  expect(() => resolveAuthConfig({ oauth: { providers: { bad: oauthProvider({ kind: "oauth2", authorizationEndpoint: "https://ok/authorize", tokenEndpoint: "http://ok/token", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }))
    .toThrow(/non-loopback http/);
  // Loopback http (local testing) → allowed; https → allowed.
  expect(() => resolveAuthConfig({ oauth: { providers: { local: oauthProvider({ kind: "oidc", issuer: "http://127.0.0.1:8080", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } })).not.toThrow();
  expect(() => resolveAuthConfig({ oauth: { providers: { g: oauthProvider({ kind: "oidc", issuer: "https://accounts.google.com", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } })).not.toThrow();
});

it("isLoopbackUrl recognizes the bracketed IPv6 loopback ([::1]) — regression pin for the URL.hostname bracket bug", () => {
  // URL#hostname always serializes IPv6 WITH brackets — new URL("http://[::1]:8080").hostname === "[::1]",
  // never the bare "::1". A bare-string comparison against "::1" is dead code; this pins the real value.
  expect(isLoopbackUrl("http://[::1]:8080")).toBe(true);
  expect(isLoopbackUrl("http://[::1]")).toBe(true);
  expect(isLoopbackUrl("http://127.0.0.1")).toBe(true);
  expect(isLoopbackUrl("http://localhost")).toBe(true);
  // Bypass attempts must stay rejected — exact hostname equality only, never substring/regex.
  expect(isLoopbackUrl("http://127.0.0.1.evil.com")).toBe(false);
  expect(isLoopbackUrl("http://localhost.evil.com")).toBe(false);
  expect(isLoopbackUrl("http://127.0.0.1@evil.com")).toBe(false); // userinfo — hostname is evil.com
  expect(isLoopbackUrl("http://evil.com#127.0.0.1")).toBe(false); // fragment — hostname is evil.com
});

it("a genuine http://[::1] provider endpoint (bracketed IPv6 loopback) is accepted at config time — THE regression pin", () => {
  const allow = ["http://localhost:5173"];
  expect(() =>
    resolveAuthConfig({ oauth: { providers: { local6: oauthProvider({ kind: "oidc", issuer: "http://[::1]:8080", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }),
  ).not.toThrow();
  expect(() =>
    resolveAuthConfig({ oauth: { providers: { local6: oauthProvider({ kind: "oidc", issuer: "http://[::1]", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }),
  ).not.toThrow();
});

it("a http://localhost provider endpoint is accepted at config time (loopback, not just 127.0.0.1)", () => {
  const allow = ["http://localhost:5173"];
  expect(() =>
    resolveAuthConfig({ oauth: { providers: { localh: oauthProvider({ kind: "oidc", issuer: "http://localhost:9999", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }),
  ).not.toThrow();
});

it("the MITM guard rejects a non-loopback http:// endpoint on every endpoint field the config loops over", () => {
  const allow = ["http://localhost:5173"];
  // oidc: issuer
  expect(() =>
    resolveAuthConfig({ oauth: { providers: { bad: oauthProvider({ kind: "oidc", issuer: "http://evil.example.com", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }),
  ).toThrow(/non-loopback http/);
  // oauth2: authorizationEndpoint
  expect(() =>
    resolveAuthConfig({
      oauth: {
        providers: { bad: oauthProvider({ kind: "oauth2", authorizationEndpoint: "http://evil.example.com/authorize", tokenEndpoint: "https://ok/token", clientId: "i", clientSecret: "s" }) },
        redirectAllowlist: allow,
      },
    }),
  ).toThrow(/non-loopback http/);
  // oauth2: tokenEndpoint
  expect(() =>
    resolveAuthConfig({
      oauth: {
        providers: { bad: oauthProvider({ kind: "oauth2", authorizationEndpoint: "https://ok/authorize", tokenEndpoint: "http://evil.example.com/token", clientId: "i", clientSecret: "s" }) },
        redirectAllowlist: allow,
      },
    }),
  ).toThrow(/non-loopback http/);
  // oauth2: userinfoEndpoint
  expect(() =>
    resolveAuthConfig({
      oauth: {
        providers: {
          bad: oauthProvider({ kind: "oauth2", authorizationEndpoint: "https://ok/authorize", tokenEndpoint: "https://ok/token", userinfoEndpoint: "http://evil.example.com/user", clientId: "i", clientSecret: "s" }),
        },
        redirectAllowlist: allow,
      },
    }),
  ).toThrow(/non-loopback http/);
  // oauth2: emailsEndpoint
  expect(() =>
    resolveAuthConfig({
      oauth: {
        providers: {
          bad: oauthProvider({ kind: "oauth2", authorizationEndpoint: "https://ok/authorize", tokenEndpoint: "https://ok/token", emailsEndpoint: "http://evil.example.com/emails", clientId: "i", clientSecret: "s" }),
        },
        redirectAllowlist: allow,
      },
    }),
  ).toThrow(/non-loopback http/);
});

it("a bypass-style host stays rejected: http://127.0.0.1.evil.com is NOT loopback", () => {
  const allow = ["http://localhost:5173"];
  expect(() =>
    resolveAuthConfig({ oauth: { providers: { bad: oauthProvider({ kind: "oidc", issuer: "http://127.0.0.1.evil.com", clientId: "i", clientSecret: "s" }) }, redirectAllowlist: allow } }),
  ).toThrow(/non-loopback http/);
});
