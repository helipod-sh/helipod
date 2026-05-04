import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCodeAt,
  currentStep,
  verifyTotp,
  buildOtpauthUri,
} from "../src/mfa/totp";

// RFC 6238 Appendix B test vectors: the shared secret is the ASCII string
// "12345678901234567890" (20 bytes), base32-encoded below (SHA1 seed), with
// digits=8 and period=30 (the RFC's own test parameters, distinct from our
// v1 config default of 6 digits — the vectors below explicitly pass 8).
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// [ time (seconds), expected 8-digit TOTP ]
const RFC_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
];

describe("base32Encode/base32Decode (RFC 4648)", () => {
  it("round-trips the RFC 6238 ASCII seed to the known base32 secret", () => {
    const seed = Buffer.from("12345678901234567890", "ascii");
    expect(base32Encode(seed)).toBe(RFC_SECRET_BASE32);
    expect(base32Decode(RFC_SECRET_BASE32).equals(seed)).toBe(true);
  });

  it("round-trips arbitrary buffers of varying lengths", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 10, 20, 33]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 7 + 3) % 256));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it("produces uppercase output with no padding", () => {
    const encoded = base32Encode(Buffer.from("hello world", "ascii"));
    expect(encoded).toBe(encoded.toUpperCase());
    expect(encoded).not.toMatch(/=/);
  });

  it("decode is tolerant of lowercase, whitespace, and padding", () => {
    const buf = Buffer.from("some secret bytes!!", "ascii");
    const canonical = base32Encode(buf);
    const messy = canonical.toLowerCase().replace(/(.{4})/g, "$1 ").trim() + "====";
    expect(base32Decode(messy).equals(buf)).toBe(true);
  });
});

describe("generateTotpSecret", () => {
  it("defaults to a 20-byte secret encoded as base32", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret).length).toBe(20);
  });

  it("respects an explicit byte length and is random per call", () => {
    const a = generateTotpSecret(32);
    const b = generateTotpSecret(32);
    expect(base32Decode(a).length).toBe(32);
    expect(a).not.toBe(b);
  });
});

describe("totpCodeAt (RFC 6238 Appendix B vectors)", () => {
  for (const [time, expected] of RFC_VECTORS) {
    it(`T=${time} -> ${expected}`, () => {
      const step = Math.floor(time / 30);
      expect(totpCodeAt(RFC_SECRET_BASE32, step, { digits: 8, period: 30 })).toBe(expected);
    });
  }

  it("zero-pads short codes to the configured digit count", () => {
    // digits=6 is the v1 default; just assert the shape, not a specific value.
    const code = totpCodeAt(RFC_SECRET_BASE32, 1);
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe("currentStep", () => {
  it("is floor(nowMs/1000/period)", () => {
    expect(currentStep(59_000, 30)).toBe(1);
    expect(currentStep(1_111_111_109_000, 30)).toBe(37_037_036);
    expect(currentStep(0, 30)).toBe(0);
    expect(currentStep(29_999, 30)).toBe(0);
    expect(currentStep(30_000, 30)).toBe(1);
  });

  it("defaults to a 30s period", () => {
    expect(currentStep(59_000)).toBe(1);
  });
});

describe("verifyTotp", () => {
  const secret = generateTotpSecret();

  it("returns the matched step for the exact current code", () => {
    const nowMs = 1_700_000_000_000;
    const step = currentStep(nowMs);
    const code = totpCodeAt(secret, step);
    expect(verifyTotp(secret, code, nowMs)).toBe(step);
  });

  it("accepts a code from one step in the past or future (±1 window)", () => {
    const nowMs = 1_700_000_000_000;
    const step = currentStep(nowMs);
    const prevCode = totpCodeAt(secret, step - 1);
    const nextCode = totpCodeAt(secret, step + 1);
    expect(verifyTotp(secret, prevCode, nowMs, { window: 1 })).toBe(step - 1);
    expect(verifyTotp(secret, nextCode, nowMs, { window: 1 })).toBe(step + 1);
  });

  it("rejects a code outside the tolerance window", () => {
    const nowMs = 1_700_000_000_000;
    const step = currentStep(nowMs);
    const farCode = totpCodeAt(secret, step + 5);
    expect(verifyTotp(secret, farCode, nowMs, { window: 1 })).toBeNull();
  });

  it("rejects a wrong code entirely", () => {
    const nowMs = 1_700_000_000_000;
    expect(verifyTotp(secret, "000000", nowMs)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    const nowMs = 1_700_000_000_000;
    expect(verifyTotp(secret, "abc", nowMs)).toBeNull();
    expect(verifyTotp(secret, "", nowMs)).toBeNull();
  });
});

describe("buildOtpauthUri", () => {
  it("produces a spec-shaped otpauth://totp/ URI that parses", () => {
    const uri = buildOtpauthUri({
      issuer: "Stackbase",
      accountName: "alice@example.com",
      secretBase32: RFC_SECRET_BASE32,
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(decodeURIComponent(parsed.pathname).replace(/^\/+/, "")).toBe("Stackbase:alice@example.com");
    expect(parsed.searchParams.get("secret")).toBe(RFC_SECRET_BASE32);
    expect(parsed.searchParams.get("issuer")).toBe("Stackbase");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });

  it("respects explicit algorithm/digits/period overrides", () => {
    const uri = buildOtpauthUri({
      issuer: "Acme",
      accountName: "bob",
      secretBase32: RFC_SECRET_BASE32,
      algorithm: "SHA1",
      digits: 8,
      period: 60,
    });
    const parsed = new URL(uri);
    expect(parsed.searchParams.get("digits")).toBe("8");
    expect(parsed.searchParams.get("period")).toBe("60");
  });
});
