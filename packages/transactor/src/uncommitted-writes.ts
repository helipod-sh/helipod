/**
 * Writes staged by a transaction but not yet committed. Keyed by document id so a
 * second write to the same document overwrites the first, and reads within the same
 * transaction see their own pending writes (read-your-own-writes). `value === null` is a
 * staged delete (tombstone).
 */
import { documentIdKey, type InternalDocumentId } from "@helipod/id-codec";
import type { DocumentValue } from "@helipod/docstore";

export interface LocalWrite {
  id: InternalDocumentId;
  value: DocumentValue | null;
}

export class UncommittedWrites {
  private readonly writes = new Map<string, LocalWrite>();

  set(id: InternalDocumentId, value: DocumentValue | null): void {
    this.writes.set(documentIdKey(id), { id, value });
  }

  get(id: InternalDocumentId): LocalWrite | undefined {
    return this.writes.get(documentIdKey(id));
  }

  has(id: InternalDocumentId): boolean {
    return this.writes.has(documentIdKey(id));
  }

  entries(): LocalWrite[] {
    return [...this.writes.values()];
  }

  get size(): number {
    return this.writes.size;
  }
}
