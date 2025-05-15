/**
 * The kernel — the HOST side of the host/guest split. User code reaches the engine ONLY by
 * calling string syscalls (`op`, `argJson` → json), which this router dispatches to handlers
 * that touch the transaction, query engine, and index maintenance. Because the boundary is
 * pure JSON strings, the exact same handlers work when the guest is a real V8 isolate.
 */
import { ForbiddenOperationError, FunctionNotFoundError } from "@stackbase/errors";
import {
  decodeDocumentId,
  encodeInternalDocumentId,
  encodeStorageTableId,
  newDocumentId,
} from "@stackbase/id-codec";
import { indexKeyspaceId, keySuccessor } from "@stackbase/index-key-codec";
import {
  computeIndexUpdates,
  extractIndexKey,
  type ComparisonOp,
  type FilterExpr,
  type Query,
  type RangeExpression,
} from "@stackbase/query-engine";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { DocumentValue } from "@stackbase/docstore";
import type { TransactionContext } from "@stackbase/transactor";
import type { QueryRuntime } from "@stackbase/query-engine";
import type { IndexCatalog } from "./catalog";
import type { UdfEnvironmentProfile } from "./profile";
import type { SeededRandom } from "./seeded-random";

export interface KernelContext {
  readonly profile: UdfEnvironmentProfile;
  readonly txn: TransactionContext;
  readonly queryRuntime: QueryRuntime;
  readonly catalog: IndexCatalog;
  readonly snapshotTs: bigint;
  readonly random: SeededRandom;
  readonly logs: string[];
}

export type SyscallHandler = (ctx: KernelContext, argJson: string) => Promise<string>;

export interface SyscallChannel {
  call(op: string, argJson: string): Promise<string>;
}

export class SyscallRouter {
  private readonly handlers = new Map<string, SyscallHandler>();
  register(op: string, handler: SyscallHandler): this {
    this.handlers.set(op, handler);
    return this;
  }
  async dispatch(ctx: KernelContext, op: string, argJson: string): Promise<string> {
    const handler = this.handlers.get(op);
    if (!handler) throw new FunctionNotFoundError(`unknown syscall: ${op}`);
    return handler(ctx, argJson);
  }
}

/** Binds a router to one invocation's context. The seam a real isolate would postMessage across. */
export class InlineSyscallChannel implements SyscallChannel {
  constructor(
    private readonly router: SyscallRouter,
    private readonly ctx: KernelContext,
  ) {}
  call(op: string, argJson: string): Promise<string> {
    return this.router.dispatch(this.ctx, op, argJson);
  }
}

function requireTable(ctx: KernelContext, name: string): { tableNumber: number } {
  const meta = ctx.catalog.getTable(name);
  if (!meta) throw new FunctionNotFoundError(`unknown table: ${name}`);
  return meta;
}

/** Maintain every index of `table` for a document change, recording write ranges for reactivity. */
function maintainIndexes(
  ctx: KernelContext,
  table: string,
  oldDoc: DocumentValue | null,
  newDoc: DocumentValue | null,
  id: ReturnType<typeof decodeDocumentId>,
): void {
  const indexes = ctx.catalog.indexesForTable(table);
  ctx.txn.stageIndexUpdates(computeIndexUpdates(indexes, oldDoc, newDoc, id));
  for (const idx of indexes) {
    const keyspace = indexKeyspaceId(encodeStorageTableId(idx.tableNumber), idx.index);
    if (oldDoc) {
      const k = extractIndexKey(oldDoc, idx.fields);
      ctx.txn.recordWrite({ keyspace, start: k, end: keySuccessor(k) });
    }
    if (newDoc) {
      const k = extractIndexKey(newDoc, idx.fields);
      ctx.txn.recordWrite({ keyspace, start: k, end: keySuccessor(k) });
    }
  }
}

const handleDbGet: SyscallHandler = async (ctx, argJson) => {
  const { id } = JSON.parse(argJson) as { id: string };
  const value = await ctx.txn.get(decodeDocumentId(id));
  return JSON.stringify(value === null ? null : convexToJson(value as Value));
};

const handleDbInsert: SyscallHandler = async (ctx, argJson) => {
  if (!ctx.profile.capabilities.dbWrite) throw new ForbiddenOperationError("writes are not allowed here");
  const { table, value } = JSON.parse(argJson) as { table: string; value: JSONValue };
  const { tableNumber } = requireTable(ctx, table);
  const id = newDocumentId(tableNumber);
  const docId = encodeInternalDocumentId(id);
  const doc: DocumentValue = {
    ...(jsonToConvex(value) as DocumentValue),
    _id: docId,
    _creationTime: Number(ctx.snapshotTs),
  };
  ctx.txn.put(id, doc);
  maintainIndexes(ctx, table, null, doc, id);
  return JSON.stringify({ id: docId });
};

const handleDbReplace: SyscallHandler = async (ctx, argJson) => {
  if (!ctx.profile.capabilities.dbWrite) throw new ForbiddenOperationError("writes are not allowed here");
  const { id, value } = JSON.parse(argJson) as { id: string; value: JSONValue };
  const internalId = decodeDocumentId(id);
  const meta = ctx.catalog.getTableByNumber(internalId.tableNumber);
  if (!meta) throw new FunctionNotFoundError(`unknown table for id ${id}`);
  const oldDoc = await ctx.txn.get(internalId);
  const newDoc: DocumentValue = {
    ...(jsonToConvex(value) as DocumentValue),
    _id: id,
    _creationTime: (oldDoc?.["_creationTime"] as number) ?? Number(ctx.snapshotTs),
  };
  ctx.txn.put(internalId, newDoc);
  maintainIndexes(ctx, meta.name, oldDoc, newDoc, internalId);
  return "{}";
};

const handleDbDelete: SyscallHandler = async (ctx, argJson) => {
  if (!ctx.profile.capabilities.dbWrite) throw new ForbiddenOperationError("writes are not allowed here");
  const { id } = JSON.parse(argJson) as { id: string };
  const internalId = decodeDocumentId(id);
  const meta = ctx.catalog.getTableByNumber(internalId.tableNumber);
  if (!meta) throw new FunctionNotFoundError(`unknown table for id ${id}`);
  const oldDoc = await ctx.txn.get(internalId);
  ctx.txn.delete(internalId);
  maintainIndexes(ctx, meta.name, oldDoc, null, internalId);
  return "{}";
};

interface QuerySpecJson {
  table: string;
  index: string;
  range?: Array<{ field: string; operator: RangeExpression["operator"]; value: JSONValue }>;
  order?: "asc" | "desc";
  filters?: Array<{ op: ComparisonOp; field: string; value: JSONValue }>;
  limit?: number;
}

const handleDbQuery: SyscallHandler = async (ctx, argJson) => {
  const spec = JSON.parse(argJson) as QuerySpecJson;
  const indexSpec = ctx.catalog.getIndex(spec.table, spec.index);
  if (!indexSpec) throw new FunctionNotFoundError(`unknown index: ${spec.table}.${spec.index}`);

  const query: Query = {
    index: indexSpec,
    range: spec.range?.map((r) => ({
      field: r.field,
      operator: r.operator,
      value: jsonToConvex(r.value) as RangeExpression["value"],
    })),
    order: spec.order,
    filters: spec.filters?.map(
      (f) => ({ op: f.op, field: f.field, value: jsonToConvex(f.value) }) as FilterExpr,
    ),
    limit: spec.limit,
  };

  const { documents, readSet } = await ctx.queryRuntime.collect(query, ctx.snapshotTs);
  for (const range of readSet.toArray()) ctx.txn.recordRead(range);
  return JSON.stringify({ docs: documents.map((d) => convexToJson(d as Value)) });
};

const handleDbPaginate: SyscallHandler = async (ctx, argJson) => {
  const spec = JSON.parse(argJson) as QuerySpecJson & { cursor: string | null; pageSize: number };
  const indexSpec = ctx.catalog.getIndex(spec.table, spec.index);
  if (!indexSpec) throw new FunctionNotFoundError(`unknown index: ${spec.table}.${spec.index}`);

  const query: Query = {
    index: indexSpec,
    range: spec.range?.map((r) => ({ field: r.field, operator: r.operator, value: jsonToConvex(r.value) as RangeExpression["value"] })),
    order: spec.order,
    filters: spec.filters?.map((f) => ({ op: f.op, field: f.field, value: jsonToConvex(f.value) }) as FilterExpr),
  };

  const { page, nextCursor, hasMore, readSet } = await ctx.queryRuntime.paginate(query, ctx.snapshotTs, {
    cursor: spec.cursor,
    pageSize: spec.pageSize,
  });
  for (const range of readSet.toArray()) ctx.txn.recordRead(range);
  return JSON.stringify({ page: page.map((d) => convexToJson(d as Value)), nextCursor, hasMore });
};

const handleConsoleLog: SyscallHandler = async (ctx, argJson) => {
  ctx.logs.push(argJson);
  return "null";
};

export function createKernelRouter(): SyscallRouter {
  return new SyscallRouter()
    .register("db.get", handleDbGet)
    .register("db.insert", handleDbInsert)
    .register("db.replace", handleDbReplace)
    .register("db.delete", handleDbDelete)
    .register("db.query", handleDbQuery)
    .register("db.paginate", handleDbPaginate)
    .register("console.log", handleConsoleLog);
}
