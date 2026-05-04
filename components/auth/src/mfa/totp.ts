import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Hand-rolled RFC 6238 TOTP (HOTP/RFC 4226 dynamic truncation underneath) on
// node:crypto HMAC-SHA1, plus RFC 4648 base32 encode/decode for secrets and
// `otpauth://` URIs. No external dependency — see the design spec (decision 1)
// for why this is hand-rolled rather than pulled in from npm.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 encode: uppercase, no padding. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/** RFC 4648 base32 decode, tolerant of lowercase input, padding ("="), and whitespace. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue; // tolerant: skip any stray non-alphabet character
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh random TOTP secret, base32-encoded (default 20 bytes = 160 bits, the RFC 6238 recommendation). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export interface TotpParams {
  algorithm?: "SHA1";
  digits?: number;
  period?: number;
}

const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

/** floor(nowMs / 1000 / period) — the RFC 6238 time-step counter. */
export function currentStep(nowMs: number, period = DEFAULT_PERIOD): number {
  return Math.floor(nowMs / 1000 / period);
}

/** RFC 6238 TOTP code (via RFC 4226 HOTP) for a given time-step counter. */
export function totpCodeAt(secretBase32: string, stepCounter: number, p?: TotpParams): string {
  const digits = p?.digits ?? DEFAULT_DIGITS;
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(stepCounter));
  const hmac = createHmac("sha1", key).update(counter).digest();
  // RFC 4226 §5.3 dynamic truncation.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return String(binCode % mod).padStart(digits, "0");
}

/**
 * Verify a presented code against the ±`window` steps around `nowMs`.
 * Returns the matched step counter (for the caller's replay-guard bookkeeping)
 * or `null` if no candidate step matches.
 */
export function verifyTotp(
  secretBase32: string,
  presented: string,
  nowMs: number,
  opts?: TotpParams & { window?: number },
): number | null {
  const digits = opts?.digits ?? DEFAULT_DIGITS;
  const window = opts?.window ?? 1;
  if (presented.length !== digits) return null;
  const presentedBuf = Buffer.from(presented, "utf8");
  const step = currentStep(nowMs, opts?.period ?? DEFAULT_PERIOD);
  for (let delta = -window; delta <= window; delta++) {
    const candidateStep = step + delta;
    if (candidateStep < 0) continue;
    const candidate = totpCodeAt(secretBase32, candidateStep, opts);
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (candidateBuf.length === presentedBuf.length && timingSafeEqual(candidateBuf, presentedBuf)) {
      return candidateStep;
    }
  }
  return null;
}

/** Build an `otpauth://totp/...` provisioning URI (Google Authenticator / RFC-adjacent conventional format). */
export function buildOtpauthUri(args: {
  issuer: string;
  accountName: string;
  secretBase32: string;
  algorithm?: string;
  digits?: number;
  period?: number;
}): string {
  const algorithm = args.algorithm ?? "SHA1";
  const digits = args.digits ?? DEFAULT_DIGITS;
  const period = args.period ?? DEFAULT_PERIOD;
  const label = encodeURIComponent(`${args.issuer}:${args.accountName}`);
  const params = new URLSearchParams({
    secret: args.secretBase32,
    issuer: args.issuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
