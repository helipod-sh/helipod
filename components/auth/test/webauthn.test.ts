import { describe, it, expect } from "vitest";
import {
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
  challengeOf,
  type StoredCredential,
} from "../src/webauthn";
import { resolvePasskeyConfig, type PasskeyConfig } from "../src/config";
import { createMockAuthenticator } from "./support/mock-authenticator";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

function testConfig(overrides?: Partial<PasskeyConfig>): PasskeyConfig {
  const cfg = resolvePasskeyConfig({ rpID: RP_ID, rpName: "Test App", origins: [ORIGIN] });
  return { ...cfg, ...overrides };
}

/** Register a fresh credential end-to-end (real options → real authenticator → real verify) and
 *  return the normalized, stored-shape credential — the fixture every authentication test below
 *  builds on. */
async function registerCredential(config: PasskeyConfig, authenticator = createMockAuthenticator()) {
  const options = await buildRegistrationOptions(config, {
    userId: "user_1",
    userName: "alice@example.com",
    existing: [],
  });
  const response = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
  const credential = await verifyRegistration(config, { response, expectedChallenge: options.challenge });
  return { authenticator, options, response, credential };
}

describe("webauthn.ts — registration", () => {
  it("happy path: real authenticator registers, verifyRegistration accepts and returns the credential", async () => {
    const config = testConfig();
    const { credential, response } = await registerCredential(config);
    expect(credential.credentialId).toBe(response.id);
    expect(credential.counter).toBe(0);
    expect(typeof credential.publicKey).toBe("string");
    expect(credential.publicKey.length).toBeGreaterThan(0);
    expect(credential.backedUp).toBe(false);
  });

  it("excludeCredentials carries the caller's existing credential ids through to the options", async () => {
    const config = testConfig();
    const options = await buildRegistrationOptions(config, {
      userId: "user_1",
      userName: "alice@example.com",
      existing: [{ credentialId: "abc123", transports: ["internal"] }],
    });
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual(["abc123"]);
  });

  it("REJECTS a registration whose clientDataJSON challenge does not match (wrong/replayed challenge)", async () => {
    const config = testConfig();
    const authenticator = createMockAuthenticator();
    const options = await buildRegistrationOptions(config, { userId: "u", userName: "a@x.com", existing: [] });
    const response = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
    await expect(
      verifyRegistration(config, { response, expectedChallenge: "not-the-real-challenge" }),
    ).rejects.toThrow();
  });

  it("REJECTS a registration signed for a different origin than configured", async () => {
    const config = testConfig();
    const authenticator = createMockAuthenticator();
    const options = await buildRegistrationOptions(config, { userId: "u", userName: "a@x.com", existing: [] });
    const response = authenticator.createRegistration({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: "http://evil.example.com",
    });
    await expect(verifyRegistration(config, { response, expectedChallenge: options.challenge })).rejects.toThrow();
  });

  it("REJECTS a registration signed for a different RP ID than configured", async () => {
    const config = testConfig();
    const authenticator = createMockAuthenticator();
    const options = await buildRegistrationOptions(config, { userId: "u", userName: "a@x.com", existing: [] });
    const response = authenticator.createRegistration({
      challenge: options.challenge,
      rpID: "attacker.example",
      origin: ORIGIN,
    });
    await expect(verifyRegistration(config, { response, expectedChallenge: options.challenge })).rejects.toThrow();
  });
});

describe("webauthn.ts — authentication", () => {
  it("happy path: real assertion verifies and returns the advanced counter", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);

    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 1,
    });
    const stored: StoredCredential = {
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
    };
    const result = await verifyAuthentication(config, {
      response: assertion,
      expectedChallenge: authOptions.challenge,
      credential: stored,
    });
    expect(result.verified).toBe(true);
    expect(result.newCounter).toBe(1);
  });

  it("usernameless (empty allowCredentials) sign-in still produces valid options; userHandle round-trips", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);

    const authOptions = await buildAuthenticationOptions(config, { allowCredentials: [] });
    expect(authOptions.allowCredentials).toEqual([]);

    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 1,
      userId: "user_1",
    });
    expect(assertion.response.userHandle).toBeTruthy();
    const result = await verifyAuthentication(config, {
      response: assertion,
      expectedChallenge: authOptions.challenge,
      credential: { credentialId: credential.credentialId, publicKey: credential.publicKey, counter: 0 },
    });
    expect(result.verified).toBe(true);
  });

  it("REJECTS a replayed/incorrect challenge", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);
    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 1,
    });
    await expect(
      verifyAuthentication(config, {
        response: assertion,
        expectedChallenge: "some-other-stale-challenge",
        credential: { credentialId: credential.credentialId, publicKey: credential.publicKey, counter: 0 },
      }),
    ).rejects.toThrow();
  });

  it("REJECTS an assertion signed for the wrong origin", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);
    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: "http://evil.example.com",
      credentialId: credential.credentialId,
      counter: 1,
    });
    await expect(
      verifyAuthentication(config, {
        response: assertion,
        expectedChallenge: authOptions.challenge,
        credential: { credentialId: credential.credentialId, publicKey: credential.publicKey, counter: 0 },
      }),
    ).rejects.toThrow();
  });

  it("REJECTS an assertion signed for the wrong RP ID", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);
    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: "attacker.example",
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 1,
    });
    await expect(
      verifyAuthentication(config, {
        response: assertion,
        expectedChallenge: authOptions.challenge,
        credential: { credentialId: credential.credentialId, publicKey: credential.publicKey, counter: 0 },
      }),
    ).rejects.toThrow();
  });

  it("REJECTS a tampered signature (verified: false, not thrown, not minted) — a forged assertion", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);
    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 1,
    });
    // Flip the last byte of the DER signature's final integer component. This mutates the
    // cryptographic value (so the signature no longer validates against the stored public key)
    // while leaving the ASN.1 length prefixes intact, so the tamper is caught by the actual
    // signature check rather than an upstream DER-parse error — proving the real crypto path, not
    // just a malformed-input guard.
    const sigBytes = Buffer.from(assertion.response.signature, "base64url");
    const lastIndex = sigBytes.length - 1;
    sigBytes[lastIndex] = (sigBytes[lastIndex] ?? 0) ^ 0xff;
    const tampered = {
      ...assertion,
      response: { ...assertion.response, signature: sigBytes.toString("base64url") },
    };
    const result = await verifyAuthentication(config, {
      response: tampered,
      expectedChallenge: authOptions.challenge,
      credential: { credentialId: credential.credentialId, publicKey: credential.publicKey, counter: 0 },
    });
    expect(result.verified).toBe(false);
  });

  it("REJECTS (throws) a counter that regressed or repeated a prior nonzero value — clone detection", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);
    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    // Stored counter is already 5 (simulating a prior successful sign-in); the authenticator now
    // reports counter 5 again (a cloned/replayed authenticator would do exactly this).
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 5,
    });
    await expect(
      verifyAuthentication(config, {
        response: assertion,
        expectedChallenge: authOptions.challenge,
        credential: { credentialId: credential.credentialId, publicKey: credential.publicKey, counter: 5 },
      }),
    ).rejects.toThrow();
  });

  it("accepts the 0/0 case (both stored and reported counter are zero — many authenticators never advance it)", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);
    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 0,
    });
    const result = await verifyAuthentication(config, {
      response: assertion,
      expectedChallenge: authOptions.challenge,
      credential: { credentialId: credential.credentialId, publicKey: credential.publicKey, counter: 0 },
    });
    expect(result.verified).toBe(true);
    expect(result.newCounter).toBe(0);
  });
});

describe("webauthn.ts — challengeOf", () => {
  it("extracts the challenge from a real clientDataJSON", async () => {
    const config = testConfig();
    const { authenticator, credential } = await registerCredential(config);
    const authOptions = await buildAuthenticationOptions(config, {
      allowCredentials: [{ credentialId: credential.credentialId }],
    });
    const assertion = authenticator.createAssertion({
      challenge: authOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: credential.credentialId,
      counter: 1,
    });
    expect(challengeOf(assertion.response.clientDataJSON)).toBe(authOptions.challenge);
  });

  it("returns \"\" for malformed input instead of throwing", () => {
    expect(challengeOf("not-valid-base64url-json!!!")).toBe("");
    expect(challengeOf(Buffer.from(JSON.stringify({ notAChallenge: true })).toString("base64url"))).toBe("");
  });
});
