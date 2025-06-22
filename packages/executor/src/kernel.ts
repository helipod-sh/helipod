/**
 * The kernel — the HOST side of the host/guest split. User code reaches the engine ONLY by
 * calling string syscalls (`op`, `argJson` → json), which this router dispatches to handlers
 * that touch the transaction, query engine, and index maintenance. Because the boundary is
 * pure JSON strings, the exact same handlers work when the guest is a real V8 isolate.
 */
import { DocumentNotFoundError, ForbiddenOperationError, FunctionNotFoundError } from "@stackbase/errors";
import {
  decodeDocumentId,
  encodeInternalDocumentId,
  encodeStorageTableId,
  newDocumentId,
  getFullTableName,
  parseFullTableName,
} from "@stackbase/id-codec";
import { indexKeyspaceId, keySuccessor } from "@stackbase/index-key-codec";
import {
  computeIndexUpdates,
  extractIndexKey,
  evaluateFilter,
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
import type { PolicyRegistry, RuleContext, RelationRegistry } from "./policy";
import { evalWritePolicy, mergeReadPolicy, resolveReadPolicy } from "./policy";

export interface KernelContext {
  readonly profile: UdfEnvironmentProfile;
  readonly txn: TransactionContext;
  readonly queryRuntime: QueryRuntime;
  readonly catalog: IndexCatalog;
  readonly snapshotTs: bigint;
  readonly random: SeededRandom;
  readonly logs: string[];
  readonly namespace: string;
  readonly privileged: boolean;
  readonly identity: string | null;
  /** Wall-clock ms captured once at execution start (fixed per OCC attempt). */
  readonly now: number;
  /** Table → policy; empty for facade / rule-context readers so enforcement never re-enters. */
  readonly policyRegistry: PolicyRegistry;
  /** Lazily builds (and memoizes) the rule-context; null when no policy provider is composed. */
  readonly getRuleContext: (() => Promise<RuleContext>) | null;
  /** Declared relations (to-many + to-one), for resolving relation predicates in read policies. */
  readonly relationRegistry: RelationRegistry;
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

async function enforceWrite(ctx: KernelContext, table: string, row: DocumentValue): Promise<void> {
  if (ctx.privileged || !ctx.getRuleContext) return;
  const policy = ctx.policyRegistry.get(table);
  if (!policy?.write) return;
  const ok = await evalWritePolicy(policy, await ctx.getRuleContext(), row as Record<string, unknown>);
  if (!ok) throw new ForbiddenOperationError(`write policy on ${table}`);
}

function requireTable(ctx: KernelContext, name: string): { tableNumber: number; fullName: string } {
  const fullName = ctx.privileged ? name : getFullTableName(name, ctx.namespace);
  const meta = ctx.catalog.getTable(fullName);
  if (!meta) throw new FunctionNotFoundError(`unknown table: ${name}`);
  return { tableNumber: meta.tableNumber, fullName };
}

/** Reject access to a document whose table is outside the running component's namespace. */
function requireOwnTable(ctx: KernelContext, fullName: string): void {
  if (ctx.privileged) return;
  if (parseFullTableName(fullName).componentPath !== ctx.namespace) {
    throw new ForbiddenOperationError(`document is not in this component's namespace`);
  }
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
  const internalId = decodeDocumentId(id);
  const meta = ctx.catalog.getTableByNumber(internalId.tableNumber);
  if (!meta) throw new FunctionNotFoundError(`unknown table for id ${id}`);
  requireOwnTable(ctx, meta.name);
  const value = await ctx.txn.get(internalId);
  if (value !== null && !ctx.privileged && ctx.getRuleContext) {
    const policy = ctx.policyRegistry.get(meta.name);
    if (policy?.read) {
      const expr = await resolveReadPolicy(policy, await ctx.getRuleContext(), meta.name, ctx.relationRegistry);
      if (expr && !evaluateFilter(value as DocumentValue, expr)) return JSON.stringify(null);
    }
  }
  return JSON.stringify(value === null ? null : convexToJson(value as Value));
};

const handleDbInsert: SyscallHandler = async (ctx, argJson) => {
  if (!ctx.profile.capabilities.dbWrite) throw new ForbiddenOperationError("writes are not allowed here");
  const { table, value } = JSON.parse(argJson) as { table: string; value: JSONValue };
  const { tableNumber, fullName } = requireTable(ctx, table);
  const id = newDocumentId(tableNumber);
  const docId = encodeInternalDocumentId(id);
  const doc: DocumentValue = {
    ...(jsonToConvex(value) as DocumentValue),
    _id: docId,
    _creationTime: Number(ctx.snapshotTs),
  };
  await enforceWrite(ctx, fullName, doc);
  ctx.txn.put(id, doc);
  maintainIndexes(ctx, fullName, null, doc, id);
  return JSON.stringify({ id: docId });
};

const handleDbReplace: SyscallHandler = async (ctx, argJson) => {
  if (!ctx.profile.capabilities.dbWrite) throw new ForbiddenOperationError("writes are not allowed here");
  const { id, value } = JSON.parse(argJson) as { id: string; value: JSONValue };
  const internalId = decodeDocumentId(id);
  const meta = ctx.catalog.getTableByNumber(internalId.tableNumber);
  if (!meta) throw new FunctionNotFoundError(`unknown table for id ${id}`);
  requireOwnTable(ctx, meta.name);
  const oldDoc = await ctx.txn.get(internalId);
  if (oldDoc === null) throw new DocumentNotFoundError(`cannot replace missing document ${id}`);
  await enforceWrite(ctx, meta.name, oldDoc);
  const newDoc: DocumentValue = {
    ...(jsonToConvex(value) as DocumentValue),
    _id: id,
    _creationTime: (oldDoc["_creationTime"] as number) ?? Number(ctx.snapshotTs),
  };
  await enforceWrite(ctx, meta.name, newDoc); // post-image: the result must also satisfy the write policy
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
  requireOwnTable(ctx, meta.name);
  const oldDoc = await ctx.txn.get(internalId);
  if (oldDoc !== null) await enforceWrite(ctx, meta.name, oldDoc);
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
  const tableName = ctx.privileged ? spec.table : getFullTableName(spec.table, ctx.namespace);
  const indexSpec = ctx.catalog.getIndex(tableName, spec.index);
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

  if (!ctx.privileged && ctx.getRuleContext) {
    const policy = ctx.policyRegistry.get(tableName);
    if (policy?.read) query.filters = mergeReadPolicy(query.filters, await resolveReadPolicy(policy, await ctx.getRuleContext(), tableName, ctx.relationRegistry));
  }

  const { documents, readSet } = await ctx.queryRuntime.collect(query, ctx.snapshotTs);
  for (const range of readSet.toArray()) ctx.txn.recordRead(range);
  return JSON.stringify({ docs: documents.map((d) => convexToJson(d as Value)) });
};

const handleDbPaginate: SyscallHandler = async (ctx, argJson) => {
  const spec = JSON.parse(argJson) as QuerySpecJson & { cursor: string | null; pageSize: number };
  const tableName = ctx.privileged ? spec.table : getFullTableName(spec.table, ctx.namespace);
  const indexSpec = ctx.catalog.getIndex(tableName, spec.index);
  if (!indexSpec) throw new FunctionNotFoundError(`unknown index: ${spec.table}.${spec.index}`);

  const query: Query = {
    index: indexSpec,
    range: spec.range?.map((r) => ({ field: r.field, operator: r.operator, value: jsonToConvex(r.value) as RangeExpression["value"] })),
    order: spec.order,
    filters: spec.filters?.map((f) => ({ op: f.op, field: f.field, value: jsonToConvex(f.value) }) as FilterExpr),
  };

  if (!ctx.privileged && ctx.getRuleContext) {
    const policy = ctx.policyRegistry.get(tableName);
    if (policy?.read) query.filters = mergeReadPolicy(query.filters, await resolveReadPolicy(policy, await ctx.getRuleContext(), tableName, ctx.relationRegistry));
  }

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
