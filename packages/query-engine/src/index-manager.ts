/**
 * Index key extraction and maintenance. An index key is the tuple of its field values
 * followed by `_creationTime` and `_id` — so keys are **unique** (the `_id` tiebreaker) and
 * carry a stable creation order. On a write, `computeIndexUpdates` diffs old vs new and
 * emits the `Deleted`/`NonClustered` index entries the write path must apply.
 */
import { encodeIndexKey, compareKeyBytes, type IndexableValue } from "@helipod/index-key-codec";
import type { DatabaseIndexUpdate, DocumentValue, InternalDocumentId } from "@helipod/docstore";
import { evaluateFieldPath } from "./filter";

export interface IndexSpec {
  /** Logical table name (for keyspace identity). */
  table: string;
  tableNumber: number;
  /** Index name; the default creation-order index is conventionally "by_creation". */
  index: string;
  /** User-declared index fields (system fields `_creationTime`/`_id` are appended). */
  fields: string[];
  /** Storage index id (from `encodeStorageIndexId`). */
  indexId: string;
}

/** Encode an index key for a document: `[...fields, _creationTime, _id]`. */
export function extractIndexKey(doc: DocumentValue, fields: string[]): Uint8Array {
  const values: IndexableValue[] = [];
  for (const field of fields) {
    const v = evaluateFieldPath(doc, field);
    values.push((v === undefined ? null : v) as IndexableValue);
  }
  values.push((doc["_creationTime"] ?? 0) as IndexableValue);
  values.push((doc["_id"] ?? "") as IndexableValue);
  return encodeIndexKey(values);
}

/**
 * Diff a document change against a set of indexes and return the index entries to apply.
 * Pass `oldDoc = null` for an insert, `newDoc = null` for a delete.
 */
export function computeIndexUpdates(
  indexes: readonly IndexSpec[],
  oldDoc: DocumentValue | null,
  newDoc: DocumentValue | null,
  docId: InternalDocumentId,
): DatabaseIndexUpdate[] {
  const updates: DatabaseIndexUpdate[] = [];
  for (const idx of indexes) {
    const oldKey = oldDoc ? extractIndexKey(oldDoc, idx.fields) : null;
    const newKey = newDoc ? extractIndexKey(newDoc, idx.fields) : null;
    if (oldKey && (newKey === null || compareKeyBytes(oldKey, newKey) !== 0)) {
      updates.push({ indexId: idx.indexId, key: oldKey, value: { type: "Deleted" } });
    }
    if (newKey) {
      updates.push({ indexId: idx.indexId, key: newKey, value: { type: "NonClustered", docId } });
    }
  }
  return updates;
}
