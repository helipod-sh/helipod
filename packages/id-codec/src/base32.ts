/**
 * Crockford Base32 — case-insensitive, omits the ambiguous letters I, L, O, U.
 * Used to render binary document ids as compact, human-safe, copy-pasteable strings.
 */
export const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // omits i l o u

const DECODE: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
    const ch = CROCKFORD_ALPHABET[i]!;
    map[ch] = i;
    map[ch.toUpperCase()] = i;
  }
  // Crockford normalization of look-alikes.
  map["i"] = map["I"] = 1;
  map["l"] = map["L"] = 1;
  map["o"] = map["O"] = 0;
  return map;
})();

export class Base32Error extends Error {
  override name = "Base32Error";
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const v = DECODE[ch];
    if (v === undefined) throw new Base32Error(`invalid base32 character: ${JSON.stringify(ch)}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Leftover bits must be zero padding (canonical form), else the string is malformed.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new Base32Error("non-canonical base32 padding bits");
  }
  return Uint8Array.from(out);
}

export function isValidBase32(text: string): boolean {
  for (const ch of text) if (DECODE[ch] === undefined) return false;
  return true;
}
