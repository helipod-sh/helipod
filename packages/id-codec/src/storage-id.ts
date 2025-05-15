/**
 * Stable string identifiers the storage layer uses to name a table's document space and
 * its indexes. Derived from the table *number* (not name) so renames never touch storage.
 */
export function encodeStorageTableId(tableNumber: number): string {
  return String(tableNumber);
}

export function decodeStorageTableId(tableId: string): number {
  const n = Number.parseInt(tableId, 10);
  if (!Number.isInteger(n) || String(n) !== tableId) throw new Error(`invalid storage table id: ${tableId}`);
  return n;
}

export function encodeStorageIndexId(tableNumber: number, indexName: string): string {
  return `${tableNumber}/${indexName}`;
}

export function decodeStorageIndexId(indexId: string): { tableNumber: number; indexName: string } {
  const sep = indexId.indexOf("/");
  if (sep < 0) throw new Error(`invalid storage index id: ${indexId}`);
  return {
    tableNumber: decodeStorageTableId(indexId.slice(0, sep)),
    indexName: indexId.slice(sep + 1),
  };
}
