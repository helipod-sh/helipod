import { describe, it, expect } from "vitest";
import { googleProvider, githubProvider, oauthProvider } from "../src/oauth";

it("googleProvider is OIDC with the right issuer + default scopes", () => {
  const p = googleProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.kind).toBe("oidc");
  expect(p.issuer).toBe("https://accounts.google.com");
  expect(p.scopes).toEqual(["openid", "email", "profile"]);
  expect(p.mapClaims({ sub: "123", email: "a@b.com", email_verified: true, name: "A" }))
    .toEqual({ accountId: "123", email: "a@b.com", emailVerified: true, name: "A" });
  expect(p.mapClaims({ sub: "123", email: "a@b.com", email_verified: false }).emailVerified).toBe(false);
});

it("githubProvider is oauth2 with explicit endpoints + numeric-id→string mapping", () => {
  const p = githubProvider({ clientId: "id", clientSecret: "sec" });
  expect(p.kind).toBe("oauth2");
  expect(p.authorizationEndpoint).toBe("https://github.com/login/oauth/authorize");
  expect(p.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
  expect(p.userinfoEndpoint).toBe("https://api.github.com/user");
  expect(p.emailsEndpoint).toBe("https://api.github.com/user/emails");
  expect(p.scopes).toEqual(["read:user", "user:email"]);
  expect(p.mapClaims({ id: 42, login: "octo", email: "o@gh.com", emailVerified: true }))
    .toEqual({ accountId: "42", email: "o@gh.com", emailVerified: true, name: "octo" });
});

it("oauthProvider passes custom overrides through", () => {
  const p = oauthProvider({ kind: "oidc", issuer: "http://localhost:9", clientId: "c", clientSecret: "s", scopes: ["openid"] });
  expect(p.issuer).toBe("http://localhost:9");
  expect(p.scopes).toEqual(["openid"]);
});
