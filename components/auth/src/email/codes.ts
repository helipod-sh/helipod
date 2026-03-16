import { randomBytes, randomInt } from "node:crypto";
import type { Flow } from "./templates";

/** OTP = 8 numeric digits, zero-padded. `crypto.randomInt` is a CSPRNG (decision 13). */
export function generateOtp(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}
/** magic/reset/verify token = exactly 32 base64url chars (24 bytes → 32 chars, decision 13). */
export function generateLinkToken(): string {
  return randomBytes(24).toString("base64url");
}
/** OTP flow shows the code; token flows embed it in a URL. */
export function isTokenFlow(flow: Flow): boolean { return flow !== "otp"; }
