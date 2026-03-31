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
