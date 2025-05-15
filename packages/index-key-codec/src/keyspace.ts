/**
 * A keyspace names the byte-ordered space a key lives in — either a table's document
 * space or one of its indexes. Read/write-set ranges are scoped to a keyspace so that
 * ranges in different indexes never spuriously overlap.
 */
export type Keyspace =
  | { kind: "table"; table: string }
  | { kind: "index"; table: string; index: string };

export function keyspaceId(ks: Keyspace): string {
  return ks.kind === "table" ? `table:${ks.table}` : `index:${ks.table}:${ks.index}`;
}

export function tableKeyspaceId(table: string): string {
  return `table:${table}`;
}

export function indexKeyspaceId(table: string, index: string): string {
  return `index:${table}:${index}`;
}

export function parseKeyspaceId(id: string): Keyspace {
  const parts = id.split(":");
  if (parts[0] === "table" && parts.length === 2) {
    return { kind: "table", table: parts[1]! };
  }
  if (parts[0] === "index" && parts.length >= 3) {
    return { kind: "index", table: parts[1]!, index: parts.slice(2).join(":") };
  }
  throw new Error(`invalid keyspace id: ${id}`);
}

/** The table a keyspace belongs to (both table and index keyspaces map to a table). */
export function tableOfKeyspaceId(id: string): string {
  return parseKeyspaceId(id).table;
}
