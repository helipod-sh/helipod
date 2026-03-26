import { describe, it, expect, afterEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createServer, type Server } from "node:http";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { defineSchema } from "@stackbase/values";
import { defineAuth, type MintResult } from "../src";

let mock: Server;
let mockUrl = "";
let priv: CryptoKey;
const KID = "test-key";

async function startIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  priv = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
  mock = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const a = mock.address();
  mockUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}

afterEach(async () => {
  await new Promise<void>((r) => mock.close(() => r()));
});

async function mint(
  claims: { sub: string; email?: string; email_verified?: boolean | string },
  over: { iss?: string; aud?: string; exp?: string } = {},
) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(over.iss ?? mockUrl)
    .setAudience(over.aud ?? "stackbase")
    .setExpirationTime(over.exp ?? "5m")
    .sign(priv);
}

async function runtime() {
  await startIssuer();
  const comp = defineAuth({ jwt: { issuers: [{ issuer: mockUrl, audience: "stackbase" }] } });
  const { catalog, moduleMap, componentNames, contextProviders, tableNumbers } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [comp],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    contextProviders,
    tableNumbers,
  });
}

describe("signInWithIdToken", () => {
  it("valid third-party JWT ⇒ JIT-provisions oidc:<issuer> + mints; second sight reuses the user", async () => {
    const rt = await runtime();
    const jwt = await mint({ sub: "u1", email: "u@ext.com", email_verified: true });
    const a = (await rt.runAction("auth:signInWithIdToken", { idToken: jwt })).value as MintResult;
    expect(await rt.run("auth:getUserId", { token: a.token }).then((r: any) => r.value)).toBe(a.userId);
    const b = (
      await rt.runAction("auth:signInWithIdToken", {
        idToken: await mint({ sub: "u1", email: "u@ext.com", email_verified: true }),
      })
    ).value as MintResult;
    expect(b.userId).toBe(a.userId); // same account, byAccount hit
  });

  it("wrong aud / expired / wrong iss ⇒ generic rejection (no enumeration)", async () => {
    const rt = await runtime();
    await expect(
      rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "x" }, { aud: "other" }) }),
    ).rejects.toThrow(/authentication failed/);
    await expect(
      rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "x" }, { exp: "-1s" }) }),
    ).rejects.toThrow(/authentication failed/);
    await expect(
      rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "x" }, { iss: "https://evil" }) }),
    ).rejects.toThrow(/authentication failed/);
  });

  it("unconfigured issuer ⇒ generic rejection", async () => {
    const rt = await runtime();
    await expect(
      rt.runAction("auth:signInWithIdToken", { idToken: await mint({ sub: "x" }, { iss: "http://127.0.0.1:1" }) }),
    ).rejects.toThrow(/authentication failed/);
  });

  it("string \"false\" email_verified is coerced to strict boolean ⇒ does NOT autolink to an existing verified-email user", async () => {
    const rt = await runtime();
    // Seed an existing verified user via a first, properly-verified sign-in under a DIFFERENT provider
    // identity but the same email, so a later "false"-string claim has a real target it must NOT link to.
    const seedJwt = await mint({ sub: "seed-sub", email: "shared@ext.com", email_verified: true });
    const seed = (await rt.runAction("auth:signInWithIdToken", { idToken: seedJwt })).value as MintResult;
    expect(seed.userId).toBeTruthy();

    // A new identity (different sub) claiming the SAME email but with email_verified as the STRING
    // "false" — some IdPs do this. Must be coerced to `false`, so it must JIT-provision a NEW user,
    // never autolink to the seeded one.
    const stringFalseJwt = await mint({ sub: "other-sub", email: "shared@ext.com", email_verified: "false" as unknown as boolean });
    const other = (await rt.runAction("auth:signInWithIdToken", { idToken: stringFalseJwt })).value as MintResult;
    expect(other.userId).not.toBe(seed.userId);
  });
});
