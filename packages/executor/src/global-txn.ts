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
    // Over-fetch the base by the number of staged ops so a staged delete/replace of a top-window row
    // can't shrink the result below `limit`; the true `limit` is applied ONCE after the overlay merge.
    //
    // NOTE: over-fetching the base ALONE is not sufficient for read-your-own-writes under a limit —
    // if the base table already has >= limit matching rows and none of them are superseded, appending
    // staged rows AFTER the (over-fetched) base rows and then slicing to `limit` still drops the staged
    // row, since it never displaces a real survivor. So staged matches are placed FIRST in the merged
    // result (guaranteeing they survive the final slice), with over-fetched base rows filling whatever
    // slots remain — which is also what backfills a slot freed by a staged delete/replace.
    const baseLimit = range.limit === undefined ? undefined : range.limit + this.ops.length;
    const base = await this.store.queryByIndex(table, { ...range, limit: baseLimit });
    const eq = range.eq ?? {};
    const matches = (doc: Record<string, unknown>) => Object.entries(eq).every(([f, val]) => doc[f] === val);

    // Staged rows for this table that match `eq` — always take priority in the result.
    const staged: Record<string, unknown>[] = [];
    const prefix = `${table}\0`;
    for (const [k, doc] of this.overlay) {
      if (!k.startsWith(prefix) || doc === null) continue; // skip other tables and staged deletes
      if (matches(doc)) staged.push(doc);
    }

    // Base rows not superseded by a staged replace/delete (a staged replace's current value is
    // already captured above via `staged`, so the base row must not also appear).
    const baseSurvivors: Record<string, unknown>[] = [];
    for (const row of base) {
      const k = key(table, String(row._id));
      if (this.overlay.has(k)) continue; // superseded by a staged replace/delete
      baseSurvivors.push(row);
    }

    const result = [...staged, ...baseSurvivors];
    return typeof range.limit === "number" ? result.slice(0, range.limit) : result;
  }

  hasWrites(): boolean {
    return this.ops.length > 0;
  }
}
