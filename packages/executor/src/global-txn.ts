import type { D1DocStore } from "@stackbase/docstore-d1";

export type GlobalWriteOp =
  | { kind: "insert"; table: string; doc: Record<string, unknown> }
  | { kind: "replace"; table: string; id: string; doc: Record<string, unknown> }
  | { kind: "delete"; table: string; id: string };

const key = (table: string, id: string) => `${table}\0${id}`;

/** A per-mutation buffer of global (D1) writes with read-your-own-writes over the D1 primary.
 *  Built fresh per transaction attempt; its `ops` are flushed by the executor as ONE atomic
 *  D1 batch AFTER the MVCC transaction resolves. Not thread-shared, not persistent. */
export class GlobalTxn {
  readonly ops: GlobalWriteOp[] = [];
  /** overlay: table\0id -> the current staged doc, or null for a staged delete. */
  private readonly overlay = new Map<string, Record<string, unknown> | null>();

  constructor(private readonly store: D1DocStore) {}

  stageInsert(table: string, doc: Record<string, unknown>): void {
    this.ops.push({ kind: "insert", table, doc });
    this.overlay.set(key(table, String(doc._id)), doc);
  }
  stageReplace(table: string, id: string, doc: Record<string, unknown>): void {
    this.ops.push({ kind: "replace", table, id, doc });
    this.overlay.set(key(table, id), { ...doc, _id: id });
  }
  stageDelete(table: string, id: string): void {
    this.ops.push({ kind: "delete", table, id });
    this.overlay.set(key(table, id), null);
  }

  async get(table: string, id: string): Promise<Record<string, unknown> | null> {
    const k = key(table, id);
    if (this.overlay.has(k)) return this.overlay.get(k) ?? null; // staged insert/replace (doc) or delete (null)
    return this.store.get(table, id);
  }

  async queryByIndex(table: string, range: { index: string; eq?: Record<string, unknown>; limit?: number }): Promise<Record<string, unknown>[]> {
    const base = await this.store.queryByIndex(table, range);
    // Overlay: drop rows the mutation deleted/replaced, then add staged rows for THIS table that match eq.
    const eq = range.eq ?? {};
    const matches = (doc: Record<string, unknown>) => Object.entries(eq).every(([f, val]) => doc[f] === val);
    const result: Record<string, unknown>[] = [];
    for (const row of base) {
      const k = key(table, String(row._id));
      if (this.overlay.has(k)) continue; // superseded by a staged replace/delete; re-added below if still matching
      result.push(row);
    }
    const prefix = `${table}\0`;
    for (const [k, doc] of this.overlay) {
      if (!k.startsWith(prefix) || doc === null) continue;
      if (matches(doc)) result.push(doc);
    }
    return typeof range.limit === "number" ? result.slice(0, range.limit) : result;
  }

  hasWrites(): boolean {
    return this.ops.length > 0;
  }
}
