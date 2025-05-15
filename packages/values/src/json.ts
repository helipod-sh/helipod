/**
 * Convex-compatible JSON encoding of values for transport. Types that have no native
 * JSON representation are tagged objects:
 *   - int64  → `{ "$integer": base64(8-byte little-endian two's-complement) }`
 *   - bytes  → `{ "$bytes":   base64 }`
 *   - non-finite float → `{ "$float": base64(8-byte IEEE-754 little-endian) }`
 * Everything else maps to its natural JSON form. `convexToJson`/`jsonToConvex` round-trip.
 */
import type { JSONValue, Value } from "./value";

/* --- base64 (portable: uses global btoa/atob, no Node Buffer) --- */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function int64ToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function bytesToInt64(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
  return BigInt.asIntN(64, x);
}

function float64ToBytes(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  return new Uint8Array(buf);
}

function bytesToFloat64(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
}

export function convexToJson(value: Value): JSONValue {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value)
        ? value
        : { $float: bytesToBase64(float64ToBytes(value)) };
    case "bigint":
      return { $integer: bytesToBase64(int64ToBytes(value)) };
    case "object": {
      if (value instanceof ArrayBuffer) {
        return { $bytes: bytesToBase64(new Uint8Array(value)) };
      }
      if (Array.isArray(value)) return value.map(convexToJson);
      const out: { [key: string]: JSONValue } = {};
      // Escape user keys starting with "$" so they can't be confused with the $integer/$float/
      // $bytes type tags ($foo → $$foo); jsonToConvex reverses it.
      for (const [k, v] of Object.entries(value)) out[k.startsWith("$") ? `$${k}` : k] = convexToJson(v);
      return out;
    }
    default:
      throw new TypeError(`Cannot encode value of type ${typeof value}`);
  }
}

export function jsonToConvex(json: JSONValue): Value {
  if (json === null) return null;
  switch (typeof json) {
    case "boolean":
    case "number":
    case "string":
      return json;
    case "object": {
      if (Array.isArray(json)) return json.map(jsonToConvex);
      const keys = Object.keys(json);
      if (keys.length === 1) {
        const k = keys[0]!;
        const raw = (json as { [key: string]: JSONValue })[k];
        if (k === "$integer" && typeof raw === "string") return bytesToInt64(base64ToBytes(raw));
        if (k === "$float" && typeof raw === "string") return bytesToFloat64(base64ToBytes(raw));
        if (k === "$bytes" && typeof raw === "string") {
          return base64ToBytes(raw).buffer as ArrayBuffer;
        }
      }
      const out: { [key: string]: Value } = {};
      for (const [key, v] of Object.entries(json)) out[key.startsWith("$$") ? key.slice(1) : key] = jsonToConvex(v);
      return out;
    }
    default:
      throw new TypeError(`Cannot decode JSON of type ${typeof json}`);
  }
}
