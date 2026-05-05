import { randomBytes } from "node:crypto";
import { base32Encode } from "./totp";

/**
 * Recovery-code generation (spec decision 7). Each code is 10 CSPRNG bytes (80 bits — comfortably
 * beyond brute-force range; recovery codes carry no attempt cap of their own, unlike a 6-digit
 * TOTP guess against `mfaAttempts`) base32-encoded (RFC 4648, `totp.ts`'s existing alphabet — no
 * ambiguous 0/O/1/I characters) and grouped into 4-char chunks joined by `-` for human
 * readability/copy-paste, e.g. `"K7QX-M3TZ-9BHN-2WCF"`.
 *
 * Generated fresh from `node:crypto` INSIDE the calling mutation (the A1 `mintSession`/A2
 * `_issueCode` CSPRNG-in-mutation precedent — an OCC replay simply regenerates fresh, unguessable
 * codes with no correctness impact). Returned RAW to the caller exactly once; callers hash each
 * with `sha256base64url` before persisting (`mfaRecoveryCodes.codeHash`) — the raw code is never
 * stored.
 */
export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) codes.push(generateOneRecoveryCode());
  return codes;
}

function generateOneRecoveryCode(): string {
  const raw = base32Encode(randomBytes(10)); // 80 bits -> 16 base32 chars, no padding
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) groups.push(raw.slice(i, i + 4));
  return groups.join("-");
}
