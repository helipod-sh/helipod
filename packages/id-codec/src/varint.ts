/**
 * LEB128 unsigned varint over uint32 (1–5 bytes). Encodes the table number that
 * prefixes a document id, so small system table numbers stay compact.
 */
export class VarintError extends Error {
  override name = "VarintError";
}

const UINT32_MAX = 0xffffffff;

export function varintEncode(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new VarintError(`varint value out of uint32 range: ${value}`);
  }
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Uint8Array.from(out);
}

export interface VarintDecodeResult {
  value: number;
  bytesRead: number;
}

export function varintDecode(bytes: Uint8Array, offset = 0): VarintDecodeResult {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= bytes.length) throw new VarintError("varint truncated");
    const byte = bytes[pos]!;
    result += (byte & 0x7f) * 2 ** shift;
    pos += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new VarintError("varint exceeds uint32");
  }
  if (result > UINT32_MAX) throw new VarintError("varint exceeds uint32");
  return { value: result, bytesRead: pos - offset };
}

export function varintEncodedLength(value: number): number {
  return varintEncode(value).length;
}
