import { describe, it, expect } from "vitest";
import { defineAuth } from "../src/component";
import { makeAuthModules } from "../src/functions";
import { resolveAuthConfig, resolvePasskeyConfig } from "../src/config";

const PASSKEY_KEYS = [
  "beginPasskeyRegistration",
  "finishPasskeyRegistration",
  "beginPasskeyAuthentication",
  "finishPasskeyAuthentication",
  "listPasskeys",
  "renamePasskey",
  "revokePasskey",
  "_storeChallenge",
  "_consumeChallenge",
  "_savePasskey",
  "_finishPasskeyAuth",
].sort();

const VALID = { rpID: "localhost", rpName: "Test App", origins: ["http://localhost:5173"] };

describe("resolvePasskeyConfig", () => {
  it("applies defaults on top of the required fields", () => {
    const cfg = resolvePasskeyConfig(VALID);
    expect(cfg.rpID).toBe("localhost");
    expect(cfg.rpName).toBe("Test App");
    expect(cfg.origins).toEqual(["http://localhost:5173"]);
    expect(cfg.challengeTtlMs).toBe(5 * 60 * 1000);
    expect(cfg.maxCredentialsPerUser).toBe(20);
    expect(cfg.userVerification).toBe("preferred");
    expect(cfg.residentKey).toBe("preferred");
  });

  it("respects explicit overrides", () => {
    const cfg = resolvePasskeyConfig({
      ...VALID,
      challengeTtlMs: 60_000,
      maxCredentialsPerUser: 5,
      userVerification: "required",
      residentKey: "discouraged",
    });
    expect(cfg.challengeTtlMs).toBe(60_000);
    expect(cfg.maxCredentialsPerUser).toBe(5);
    expect(cfg.userVerification).toBe("required");
    expect(cfg.residentKey).toBe("discouraged");
  });

  it("throws on empty rpID", () => {
    expect(() => resolvePasskeyConfig({ ...VALID, rpID: "" })).toThrow(/rpID/);
  });

  it("throws on empty rpName", () => {
    expect(() => resolvePasskeyConfig({ ...VALID, rpName: "" })).toThrow(/rpName/);
  });

  it("throws on empty origins", () => {
    expect(() => resolvePasskeyConfig({ ...VALID, origins: [] })).toThrow(/origins/);
  });

  it("rejects a non-loopback http:// origin (via assertUrlIsSecure — the A3 MITM guard reused)", () => {
    expect(() => resolvePasskeyConfig({ ...VALID, origins: ["http://evil.example.com"] })).toThrow(/non-loopback http/);
  });

  it("accepts a https:// origin", () => {
    expect(() => resolvePasskeyConfig({ ...VALID, origins: ["https://example.com"] })).not.toThrow();
  });

  it("accepts a loopback http://localhost origin", () => {
    expect(() => resolvePasskeyConfig({ ...VALID, origins: ["http://localhost:5173"] })).not.toThrow();
  });
});

describe("resolveAuthConfig({ passkeys })", () => {
  it("passkeys absent -> config.passkeys is undefined (byte-identical to pre-passkeys)", () => {
    const config = resolveAuthConfig({});
    expect(config.passkeys).toBeUndefined();
  });

  it("passkeys present -> config.passkeys is a resolved PasskeyConfig", () => {
    const config = resolveAuthConfig({ passkeys: VALID });
    expect(config.passkeys).toBeDefined();
    expect(config.passkeys!.rpID).toBe("localhost");
    expect(config.passkeys!.maxCredentialsPerUser).toBe(20);
  });
});

describe("conditional registration (default-inert proof)", () => {
  it("passkeys absent ⇒ NONE of the eleven passkey keys are registered", () => {
    const keys = Object.keys(makeAuthModules(resolveAuthConfig()));
    for (const k of PASSKEY_KEYS) expect(keys).not.toContain(k);
  });

  it("passkeys present ⇒ ALL eleven passkey keys are registered", () => {
    const cfg = resolveAuthConfig({ passkeys: VALID });
    const keys = Object.keys(makeAuthModules(cfg)).sort();
    for (const k of PASSKEY_KEYS) expect(keys).toContain(k);
  });

  it("httpRoutes is unchanged by adding passkeys (still absent — passkeys add zero routes)", () => {
    expect(defineAuth({ passkeys: VALID }).httpRoutes).toBeUndefined();
  });
});
