import { query, type RegisteredFunction } from "@helipod/executor";
import { convexToJson, type JSONValue, type Value } from "@helipod/values";
import type { ComparisonOp } from "@helipod/query-engine";

export interface FilterCond { field: string; op: ComparisonOp; value: JSONValue }
const MAX_SCAN = 1000;
const PAGE_SIZE = 50;

/** Privileged, subscribable table browser. Reads any full-named table via cursor paginate + filters. */
export const browseTableModule: RegisteredFunction = query(async (ctx, args: {
  table: string; cursor?: string | null; pageSize?: number; filter?: FilterCond[];
}) => {
  const b = (ctx as unknown as { db: { query(t: string, i: string): { where(op: ComparisonOp, f: string, v: Value): unknown; paginate(o: { cursor?: string | null; pageSize: number; maxScan: number }): Promise<{ page: unknown[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }> } } })
    .db.query(args.table, "by_creation");
  for (const c of args.filter ?? []) (b as { where(op: ComparisonOp, f: string, v: Value): unknown }).where(c.op, c.field, c.value as Value);
  const res = await (b as { paginate(o: { cursor?: string | null; pageSize: number; maxScan: number }): Promise<{ page: unknown[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }> })
    .paginate({ cursor: args.cursor ?? null, pageSize: args.pageSize ?? PAGE_SIZE, maxScan: MAX_SCAN });
  return {
    documents: (res.page as Value[]).map((d) => convexToJson(d)),
    nextCursor: res.nextCursor, hasMore: res.hasMore, scanCapped: res.scanCapped,
  } as JSONValue;
});
