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
    const resolver = (as as unknown as Record<symbol, unknown>)[expectedIssuerKey] as ((r: { claims: Record<string, unknown> }) => string) | undefined;
    expect(typeof resolver).toBe("function");
    expect(resolver!({ claims: { iss: "https://tenant.example/v2.0" } })).toBe("https://tenant.example/v2.0");
  });

  it("leaves _expectedIssuer unset when the provider declares no expectedIssuer (A3 strict default)", async () => {
    await startDiscovery();
    const p = oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "c", clientSecret: "s" });
    const as = await authorizationServerFor(p);
    expect((as as unknown as Record<symbol, unknown>)[expectedIssuerKey]).toBeUndefined();
  });
});
