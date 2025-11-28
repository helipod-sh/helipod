/**
 * Document identity. Internally a document is `(tableNumber, internalId)` where
 * `internalId` is 16 random bytes. The developer-facing `DocumentId` string is:
 *
 *     base32( varint(tableNumber) ++ internalId(16) ++ fletcher16(prefix)[2] )
 *
 * giving a compact (31–37 char), self-validating, order-irrelevant id. The table number
 * (not the name) is embedded, so renaming a table never rewrites its ids.
 */
import { base32Encode, base32Decode, Base32Error } from "./base32";
import { fletcher16, verifyFletcher16 } from "./checksum";
import { varintEncode, varintDecode, varintEncodedLength } from "./varint";

export type InternalId = Uint8Array;

export const INTERNAL_ID_BYTES = 16;
const CHECKSUM_BYTES = 2;

export interface InternalDocumentId {
  tableNumber: number;
  internalId: InternalId;
}

declare const docIdBrand: unique symbol;
export type DocumentId = string & { readonly [docIdBrand]: "DocumentId" };

export class DocumentIdError extends Error {
  override name = "DocumentIdError";
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function internalIdToHex(internalId: InternalId): string {
  let hex = "";
  for (let i = 0; i < internalId.length; i++) hex += internalId[i]!.toString(16).padStart(2, "0");
  return hex;
}

function hexToInternalId(hex: string): InternalId {
  if (hex.length % 2 !== 0) throw new DocumentIdError("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new DocumentIdError("invalid hex");
    out[i] = byte;
  }
  return out;
}

export function generateInternalId(): InternalId {
  const bytes = new Uint8Array(INTERNAL_ID_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function newDocumentId(tableNumber: number): InternalDocumentId {
  return { tableNumber, internalId: generateInternalId() };
}

export function encodeDocumentId(tableNumber: number, internalId: InternalId): DocumentId {
  if (internalId.length !== INTERNAL_ID_BYTES) {
    throw new DocumentIdError(`internalId must be ${INTERNAL_ID_BYTES} bytes, got ${internalId.length}`);
  }
  const prefix = concatBytes(varintEncode(tableNumber), internalId);
  const checksum = fletcher16(prefix);
  const checksumBytes = new Uint8Array([(checksum >>> 8) & 0xff, checksum & 0xff]);
  return base32Encode(concatBytes(prefix, checksumBytes)) as DocumentId;
}

export function encodeInternalDocumentId(id: InternalDocumentId): DocumentId {
  return encodeDocumentId(id.tableNumber, id.internalId);
}

/** Mint a full encoded document id CLIENT-SIDE (same shape and entropy as the engine's own
 *  minting — 16 random bytes). The engine validates at insert; see client-supplied ids spec. */
export function mintEncodedDocumentId(tableNumber: number): DocumentId {
  return encodeInternalDocumentId(newDocumentId(tableNumber));
}

export function decodeDocumentId(encoded: string): InternalDocumentId {
  let bytes: Uint8Array;
  try {
    bytes = base32Decode(encoded);
  } catch (e) {
    throw new DocumentIdError(e instanceof Base32Error ? e.message : "invalid base32");
  }
  let tableNumber: number;
  let bytesRead: number;
  try {
    ({ value: tableNumber, bytesRead } = varintDecode(bytes, 0));
  } catch {
    throw new DocumentIdError("invalid table number");
  }
  const internalIdEnd = bytesRead + INTERNAL_ID_BYTES;
  if (bytes.length !== internalIdEnd + CHECKSUM_BYTES) {
    throw new DocumentIdError("incorrect id length");
  }
  const internalId = bytes.slice(bytesRead, internalIdEnd);
  const checksum = (bytes[internalIdEnd]! << 8) | bytes[internalIdEnd + 1]!;
  const prefix = bytes.slice(0, internalIdEnd);
  if (!verifyFletcher16(prefix, checksum)) throw new DocumentIdError("checksum mismatch");
  return { tableNumber, internalId };
}

export function tryDecodeDocumentId(encoded: string): InternalDocumentId | null {
  try {
    return decodeDocumentId(encoded);
  } catch {
    return null;
  }
}

export function isValidDocumentId(encoded: string, expectedTableNumber?: number): boolean {
  const decoded = tryDecodeDocumentId(encoded);
  if (decoded === null) return false;
  return expectedTableNumber === undefined || decoded.tableNumber === expectedTableNumber;
}

/** The encoded length in characters for ids of a given table number (31–37). */
export function getEncodedLength(tableNumber: number): number {
  const byteLen = varintEncodedLength(tableNumber) + INTERNAL_ID_BYTES + CHECKSUM_BYTES;
  return Math.ceil((byteLen * 8) / 5);
}

/* --- stable Map/Set keys for InternalDocumentId --- */

export function documentIdKey(id: InternalDocumentId): string {
  return `${id.tableNumber}:${internalIdToHex(id.internalId)}`;
}

export function parseDocumentIdKey(key: string): InternalDocumentId {
  const sep = key.indexOf(":");
  if (sep < 0) throw new DocumentIdError("invalid document id key");
  const tableNumber = Number.parseInt(key.slice(0, sep), 10);
  if (!Number.isInteger(tableNumber)) throw new DocumentIdError("invalid table number in key");
  return { tableNumber, internalId: hexToInternalId(key.slice(sep + 1)) };
}

export function documentIdsEqual(a: InternalDocumentId, b: InternalDocumentId): boolean {
  if (a.tableNumber !== b.tableNumber || a.internalId.length !== b.internalId.length) return false;
  for (let i = 0; i < a.internalId.length; i++) if (a.internalId[i] !== b.internalId[i]) return false;
  return true;
}
