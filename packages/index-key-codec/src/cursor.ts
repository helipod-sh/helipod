/**
 * Opaque pagination cursors. A cursor pins a stable position in a result set so that
 * paginating a query is gapless even as rows are inserted/deleted at the head — the basis
 * for WhatsApp-style infinite scrollback (spectrum §2.6).
 *
 *  - `SimpleCursor`: just a document id (for `_creationTime`/`_id`-ordered scans).
 *  - `IndexCursor`: the index field values plus `_id`, so resumption is exact under an index.
 *
 * `indexKey` holds the field values in JSON-transport form (`convexToJson` per field) so the
 * cursor is a plain string on the wire.
 */
import type { JSONValue } from "@stackbase/values";

export interface SimpleCursor {
  kind: "simple";
  id: string;
}

export interface IndexCursor {
  kind: "index";
  id: string;
  indexKey: JSONValue[];
}

export type Cursor = SimpleCursor | IndexCursor;

export class InvalidCursorError extends Error {
  override name = "InvalidCursorError";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToString(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(cursor: Cursor): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeCursor(s: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64ToString(s));
  } catch {
    throw new InvalidCursorError("cursor is not valid base64 JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    throw new InvalidCursorError("cursor is missing an id");
  }
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind === "simple") return parsed as SimpleCursor;
  if (kind === "index" && Array.isArray((parsed as IndexCursor).indexKey)) {
    return parsed as IndexCursor;
  }
  throw new InvalidCursorError("cursor has an unknown kind");
}

export function getCursorId(cursor: Cursor): string {
  return cursor.id;
}
