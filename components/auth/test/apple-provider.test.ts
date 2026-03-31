import { describe, it, expect } from "vitest";
import { generateKeyPair, exportPKCS8, decodeJwt, decodeProtectedHeader, jwtVerify, importSPKI, exportSPKI } from "jose";
import { appleProvider, appleClientSecretMinter } from "../src/oauth";

/** A fresh ES256 keypair, returning the PKCS#8 PEM (minter input) + the SPKI PEM (verify key). */
async function es256Pem(): Promise<{ pkcs8: string; spki: string }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return { pkcs8: await exportPKCS8(privateKey), spki: await exportSPKI(publicKey) };
}

describe("appleClientSecretMinter", () => {
  it("mints an ES256 JWT with the exact Apple header + claims, verifiable against the public key", async () => {
    const { pkcs8, spki } = await es256Pem();
    const nowMs = 1_700_000_000_000;
    const mint = appleClientSecretMinter({ clientId: "com.acme.svc", teamId: "TEAM123", keyId: "KEY123", privateKey: pkcs8, nowFn: () => nowMs });
    const jwt = await mint();

    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "KEY123" });
    const claims = decodeJwt(jwt);
    const nowSec = Math.floor(nowMs / 1000);
    expect(claims.iss).toBe("TEAM123");
    expect(claims.sub).toBe("com.acme.svc");
    expect(claims.aud).toBe("https://appleid.apple.com");
    expect(claims.iat).toBe(nowSec);
    expect(claims.exp).toBeGreaterThan(nowSec);
    expect((claims.exp as number) - nowSec).toBeLessThanOrEqual(60 * 60 * 24 * 180); // ≤ 6 months
    // Signature verifies against the public key with the ES256 algorithm. `currentDate` pins
    // jose's exp/iat validation to the same frozen `nowFn` clock the minter used — without it,
    // jwtVerify checks `exp` against the REAL wall clock, and a JWT minted at a fixed past
    // timestamp (as this test does) would spuriously read as expired.
    const key = await importSPKI(spki, "ES256");
    const { payload } = await jwtVerify(jwt, key, {
      audience: "https://appleid.apple.com",
      issuer: "TEAM123",
      currentDate: new Date(nowMs),
    });
    expect(payload.sub).toBe("com.acme.svc");
  });

  it("caches within the window and re-mints past it", async () => {
    const { pkcs8 } = await es256Pem();
    let nowMs = 1_700_000_000_000;
    const mint = appleClientSecretMinter({ clientId: "c", teamId: "t", keyId: "k", privateKey: pkcs8, ttlSec: 3600, nowFn: () => nowMs });
    const a = await mint();
    const b = await mint();                 // same window ⇒ identical cached secret
    expect(b).toBe(a);
    nowMs += 3600_000;                       // advance past exp − skew ⇒ re-mint
    const c = await mint();
    expect(c).not.toBe(a);
  });
});

describe("appleProvider", () => {
  it("is OIDC + form_post + name/email scopes with an async clientSecret minter", () => {
    const p = appleProvider({ clientId: "com.acme.svc", teamId: "T", keyId: "K", privateKey: "pem" });
    expect(p.kind).toBe("oidc");
    expect(p.issuer).toBe("https://appleid.apple.com");
    expect(p.scopes).toEqual(["name", "email"]);
    expect(p.responseMode).toBe("form_post");
    expect(typeof p.clientSecret).toBe("function");
  });

  it("mapClaims: email_verified accepts string OR boolean; identity from claims; name from extra.user (never email)", () => {
    const p = appleProvider({ clientId: "c", teamId: "T", keyId: "K", privateKey: "pem" });
    // string "true" and boolean true both → true; "false"/false/absent → false.
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: "true" }).emailVerified).toBe(true);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: true }).emailVerified).toBe(true);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: "false" }).emailVerified).toBe(false);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com", email_verified: false }).emailVerified).toBe(false);
    expect(p.mapClaims({ sub: "s", email: "a@icloud.com" }).emailVerified).toBe(false);
    // accountId from sub; email from claims only.
    expect(p.mapClaims({ sub: "apple-123", email: "a@icloud.com", email_verified: true }))
      .toMatchObject({ accountId: "apple-123", email: "a@icloud.com", emailVerified: true });
    // name composed from extra.user.name (first-auth); extra.user.email is IGNORED.
    const withName = p.mapClaims({ sub: "s", email: "real@icloud.com", email_verified: true }, { user: { name: { firstName: "Ada", lastName: "Lovelace" }, email: "attacker@evil.com" } });
    expect(withName.name).toBe("Ada Lovelace");
    expect(withName.email).toBe("real@icloud.com"); // from claims, NOT extra.user.email
    // no extra ⇒ no name (subsequent sign-ins, where Apple sends no user JSON).
    expect(p.mapClaims({ sub: "s", email: "real@icloud.com", email_verified: true }).name).toBeUndefined();
    // REQUIRED pin (T5 review follow-up): even when the id_token itself carries NO email, the mapper
    // must NEVER fall back to reading `extra.user.email` for identity — that field is cosmetic-name-only
    // (decision 1). Without this, a malicious/misbehaving relay that supplies a `user.email` alongside a
    // no-email id_token could smuggle an attacker-chosen email into the identity.
    expect(p.mapClaims({ sub: "s" }, { user: { email: "attacker@evil.com" } }).email).toBeUndefined();
  });
});
