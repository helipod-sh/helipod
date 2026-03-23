import { describe, it, expect } from "vitest";
import { defineAuth } from "../src/component";
import { makeAuthModules } from "../src/functions";
import { resolveAuthConfig } from "../src/config";
import { googleProvider, oauthProvider } from "../src/oauth";
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
  expect(comp.httpRoutes).toEqual([{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "oauthHttp" }]);
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
