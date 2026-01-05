/**
 * The GUEST side of the host/guest split — the `ctx.db` API user functions call. Every
 * method serializes its arguments to JSON and crosses the `SyscallChannel`; nothing here
 * touches the engine directly. Queries get a read-only `GuestDatabaseReader`; mutations get
 * a `GuestDatabaseWriter`.
 */
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { DocumentValue } from "@stackbase/docstore";
import type { ComparisonOp, ScanOrder } from "@stackbase/query-engine";
import { COLLECT_BRAND, type SyscallChannel } from "./kernel";

export type DocId = string;

export class QueryBuilder {
  private readonly range: Array<{ field: string; operator: "eq" | "gt" | "gte" | "lt" | "lte"; value: Value }> = [];
  private readonly filters: Array<{ op: ComparisonOp; field: string; value: Value }> = [];
  private orderDir: ScanOrder = "asc";
  private limitN: number | undefined;

  constructor(
    private readonly channel: SyscallChannel,
    private readonly table: string,
    private readonly index: string,
  ) {}

  eq(field: string, value: Value): this {
    this.range.push({ field, operator: "eq", value });
    return this;
  }
  gt(field: string, value: Value): this {
    this.range.push({ field, operator: "gt", value });
    return this;
  }
  gte(field: string, value: Value): this {
    this.range.push({ field, operator: "gte", value });
    return this;
  }
  lt(field: string, value: Value): this {
    this.range.push({ field, operator: "lt", value });
    return this;
  }
  lte(field: string, value: Value): this {
    this.range.push({ field, operator: "lte", value });
    return this;
  }
  order(dir: ScanOrder): this {
    this.orderDir = dir;
    return this;
  }
  where(op: ComparisonOp, field: string, value: Value): this {
    this.filters.push({ op, field, value });
    return this;
  }
  take(n: number): this {
    this.limitN = n;
    return this;
  }

  private serializeQuery(): string {
    return JSON.stringify({
      table: this.table,
      index: this.index,
      range: this.range.map((r) => ({ field: r.field, operator: r.operator, value: convexToJson(r.value) })),
      order: this.orderDir,
      filters: this.filters.map((f) => ({ op: f.op, field: f.field, value: convexToJson(f.value) })),
      limit: this.limitN,
    });
  }

  async collect(): Promise<DocumentValue[]> {
    const res = await this.channel.call("db.query", this.serializeQuery());
    const { docs, collectToken } = JSON.parse(res) as { docs: JSONValue[]; collectToken?: string };
    const out = docs.map((d) => jsonToConvex(d) as DocumentValue);
    // DLR 2b passthrough identity brand: stamp this collect's token (non-enumerably, so it never
    // reaches JSON/reactivity) onto the returned array. The executor classifies the run DIFFABLE_RANGE
    // only when the handler returns THIS exact array — any slice/filter/map/spread yields a fresh,
    // unbranded array and correctly falls back to a full RERUN. `collectToken` is absent for reads
    // that aren't a traced top-level query collect, so nothing is branded there. See COLLECT_BRAND.
    if (collectToken !== undefined) {
      Object.defineProperty(out, COLLECT_BRAND, { value: collectToken, enumerable: false, configurable: true });
    }
    return out;
  }

  async paginate(opts: {
    cursor?: string | null;
    pageSize: number;
    maxScan?: number;
  }): Promise<{ page: DocumentValue[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }> {
    const res = await this.channel.call("db.paginate", JSON.stringify({ ...JSON.parse(this.serializeQuery()), cursor: opts.cursor ?? null, pageSize: opts.pageSize, maxScan: opts.maxScan }));
    const parsed = JSON.parse(res) as { page: JSONValue[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean };
    return { page: parsed.page.map((d) => jsonToConvex(d) as DocumentValue), nextCursor: parsed.nextCursor, hasMore: parsed.hasMore, scanCapped: parsed.scanCapped };
  }
}

export class GuestDatabaseReader {
  constructor(protected readonly channel: SyscallChannel) {}

  async get(id: DocId): Promise<DocumentValue | null> {
    const res = await this.channel.call("db.get", JSON.stringify({ id }));
    const json = JSON.parse(res) as JSONValue;
    return json === null ? null : (jsonToConvex(json) as DocumentValue);
  }

  query(table: string, index: string): QueryBuilder {
    return new QueryBuilder(this.channel, table, index);
  }
}

export class GuestDatabaseWriter extends GuestDatabaseReader {
  async insert(table: string, value: DocumentValue): Promise<DocId> {
    const res = await this.channel.call("db.insert", JSON.stringify({ table, value: convexToJson(value as Value) }));
    return (JSON.parse(res) as { id: DocId }).id;
  }
  async replace(id: DocId, value: DocumentValue): Promise<void> {
    await this.channel.call("db.replace", JSON.stringify({ id, value: convexToJson(value as Value) }));
  }
  async delete(id: DocId): Promise<void> {
    await this.channel.call("db.delete", JSON.stringify({ id }));
  }
}

export interface QueryCtx {
  db: GuestDatabaseReader;
  random(): number;
  now(): number;
}
export interface MutationCtx {
  db: GuestDatabaseWriter;
  random(): number;
  now(): number;
}

/**
 * A ref carries its resolved path (`__path`, set by the generated `api` proxy) or a caller
 * passes the path string directly. Structural (not imported from `@stackbase/client`) to avoid
 * a dependency cycle — `@stackbase/client` doesn't depend on the executor, but pulling it in
 * here would still add an unnecessary package edge for a one-field shape.
 */
export interface FunctionReference {
  __path: string;
}

/**
 * The action GUEST context. Actions run OUTSIDE any transaction — no read/write-set tracking,
 * no commit — so, structurally, there is NO `db`. All data access goes through `runQuery`/
 * `runMutation`, each of which is a fresh, independent top-level run (its own transaction).
 * Native capabilities (fetch, Date, Math.random, timers) are available because actions don't
 * need deterministic replay the way queries/mutations do.
 */
export interface ActionCtx {
  runQuery<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
  runMutation<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
  runAction<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
}
