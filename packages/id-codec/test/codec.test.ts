import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  isValidBase32,
  Base32Error,
  fletcher16,
  verifyFletcher16,
  varintEncode,
  varintDecode,
  varintEncodedLength,
  VarintError,
  encodeDocumentId,
  decodeDocumentId,
  tryDecodeDocumentId,
  isValidDocumentId,
  getEncodedLength,
  documentIdKey,
  parseDocumentIdKey,
  documentIdsEqual,
  newDocumentId,
  INTERNAL_ID_BYTES,
} from "../src/index";

const id16 = (seed: number): Uint8Array =>
  Uint8Array.from({ length: INTERNAL_ID_BYTES }, (_, i) => (seed * 31 + i * 7) & 0xff);

describe("base32 (Crockford)", () => {
  it("round-trips arbitrary byte strings", () => {
    for (const bytes of [[], [0], [255], [1, 2, 3, 4, 5], Array.from({ length: 20 }, (_, i) => i * 13)]) {
      const b = Uint8Array.from(bytes);
      expect([...base32Decode(base32Encode(b))]).toEqual([...b]);
    }
  });

  it("normalizes look-alikes and rejects invalid characters", () => {
    expect(isValidBase32("o0Il1")).toBe(true); // o→0, I/l→1
    expect(isValidBase32("u")).toBe(false); // excluded
    expect(isValidBase32("!")).toBe(false);
    expect(() => base32Decode("u")).toThrow(Base32Error);
  });

  it("rejects non-canonical trailing bits", () => {
    expect(() => base32Decode("1")).toThrow(/non-canonical/);
  });
});

describe("fletcher16", () => {
  it("verifies and detects corruption", () => {
    const bytes = new TextEncoder().encode("the quick brown fox");
    const sum = fletcher16(bytes);
    expect(verifyFletcher16(bytes, sum)).toBe(true);
    const corrupted = Uint8Array.from(bytes);
    corrupted[3] = corrupted[3]! ^ 0x01;
    expect(verifyFletcher16(corrupted, sum)).toBe(false);
  });
});

describe("varint", () => {
  it("round-trips uint32 values", () => {
    for (const v of [0, 1, 127, 128, 300, 16384, 2 ** 21, 0xffffffff]) {
      const enc = varintEncode(v);
      const { value, bytesRead } = varintDecode(enc);
      expect(value).toBe(v);
      expect(bytesRead).toBe(enc.length);
      expect(varintEncodedLength(v)).toBe(enc.length);
    }
  });

  it("rejects out-of-range values", () => {
    expect(() => varintEncode(-1)).toThrow(VarintError);
    expect(() => varintEncode(2 ** 32)).toThrow(VarintError);
    expect(() => varintEncode(1.5)).toThrow(VarintError);
  });
});

describe("document id codec", () => {
  const tableNumbers = [1, 100, 9999, 10001, 70000, 0xffffffff];

  it("round-trips (tableNumber, internalId) for varied table numbers", () => {
    for (const tn of tableNumbers) {
      const internalId = id16(tn);
      const encoded = decodeDocumentId(encodeDocumentId(tn, internalId));
      expect(encoded.tableNumber).toBe(tn);
      expect([...encoded.internalId]).toEqual([...internalId]);
    }
  });

  it("produces ids 31–37 characters, matching getEncodedLength", () => {
    for (const tn of tableNumbers) {
      const encoded = encodeDocumentId(tn, id16(tn));
      expect(encoded.length).toBeGreaterThanOrEqual(31);
      expect(encoded.length).toBeLessThanOrEqual(37);
      expect(encoded.length).toBe(getEncodedLength(tn));
    }
  });

  it("rejects a corrupted id via the checksum (no DB round-trip)", () => {
    const encoded = encodeDocumentId(100, id16(42));
    const bytes = base32Decode(encoded);
    bytes[5] = bytes[5]! ^ 0x01; // flip a bit inside the internalId region
    const corrupted = base32Encode(bytes);
    expect(tryDecodeDocumentId(corrupted)).toBeNull();
    expect(() => decodeDocumentId(corrupted)).toThrow(/checksum|length/);
  });

  it("rejects truncated and garbage ids", () => {
    expect(tryDecodeDocumentId("")).toBeNull();
    expect(tryDecodeDocumentId("abc")).toBeNull();
    expect(isValidDocumentId("not a real id!")).toBe(false);
  });

  it("isValidDocumentId can assert the expected table", () => {
    const encoded = encodeDocumentId(10001, id16(7));
    expect(isValidDocumentId(encoded)).toBe(true);
    expect(isValidDocumentId(encoded, 10001)).toBe(true);
    expect(isValidDocumentId(encoded, 10002)).toBe(false);
  });

  it("documentIdKey round-trips and compares structurally", () => {
    const a = newDocumentId(10001);
    const key = documentIdKey(a);
    const parsed = parseDocumentIdKey(key);
    expect(documentIdsEqual(a, parsed)).toBe(true);
    expect(documentIdsEqual(a, newDocumentId(10001))).toBe(false); // different random id
  });

  it("generates 16-byte internal ids", () => {
    expect(newDocumentId(1).internalId.length).toBe(INTERNAL_ID_BYTES);
  });
});
