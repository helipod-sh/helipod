import { describe, it, expect } from "vitest";
import { googleProvider, githubProvider, discordProvider, facebookProvider, FACEBOOK_GRAPH_VERSION, oauthProvider } from "../src/oauth";

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
  // a non-string email value (e.g. malformed upstream payload) is treated as absent, not coerced.
  const nonString = p.mapClaims({ id: 999, name: "Weird", email: 12345 as unknown as string });
  expect(nonString.email).toBeUndefined();
  expect(nonString.emailVerified).toBe(false);
});

it("facebookProvider honors a graphVersion override consistently across all three endpoints", () => {
  const p = facebookProvider({ clientId: "id", clientSecret: "sec", graphVersion: "v21.0" });
  expect(p.authorizationEndpoint).toContain("/v21.0/");
  expect(p.tokenEndpoint).toContain("/v21.0/");
  expect(p.userinfoEndpoint).toContain("/v21.0/");
});
