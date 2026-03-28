import { describe, it, expect } from "vitest";
import { googleProvider, githubProvider, discordProvider, oauthProvider } from "../src/oauth";

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
