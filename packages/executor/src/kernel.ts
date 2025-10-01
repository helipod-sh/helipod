/**
 * The kernel — the HOST side of the host/guest split. User code reaches the engine ONLY by
 * calling string syscalls (`op`, `argJson` → json), which this router dispatches to handlers
 * that touch the transaction, query engine, and index maintenance. Because the boundary is
 * pure JSON strings, the exact same handlers work when the guest is a real V8 isolate.
 */
import { DocumentNotFoundError, DocumentValidationError, ForbiddenOperationError, FunctionNotFoundError } from "@stackbase/errors";
import {
  decodeDocumentId,
  encodeInternalDocumentId,
  encodeStorageTableId,
  newDocumentId,
  getFullTableName,
  parseFullTableName,
  shardIdForKeyValue,
  type ShardId,
} from "@stackbase/id-codec";
import { indexKeyspaceId, keySuccessor, encodeIndexKey, indexKeysEqual, type IndexableValue, type KeyRange } from "@stackbase/index-key-codec";
import {
  computeIndexUpdates,
  extractIndexKey,
  evaluateFilter,
  type ComparisonOp,
  type FilterExpr,
  type Query,
  type RangeExpression,
} from "@stackbase/query-engine";
import { convexToJson, jsonToConvex, validate, type JSONValue, type Value } from "@stackbase/values";
import type { DocumentValue } from "@stackbase/docstore";
import type { TransactionContext } from "@stackbase/transactor";
import type { QueryRuntime } from "@stackbase/query-engine";
import type { IndexCatalog, TableMeta } from "./catalog";
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
  /** The shard this transaction runs on (a mutation's resolved `shardBy`, else `"default"`). */
  readonly shardId: ShardId;
  /** NUM_SHARDS for this deployment; how the guards route a document's shard-key value to a shard. */
  readonly numShards: number;
  /** Whether the running mutation DECLARED a `shardBy` (a "sharded mutation"). A no-`shardBy`
   *  mutation (`"default"` shard) may read everything but may not write sharded tables; a
   *  sharded mutation is subject to the full read+write ownership matrix (D3). */
  readonly shardDeclared: boolean;
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

/** Validate a user-provided document value against the table's schema validator (if any). */
function validateDocumentForWrite(meta: TableMeta | undefined, tableName: string, value: DocumentValue): void {
  const validator = meta?.documentValidator;
  if (!validator) return;
  const failures = validate(validator, value as Value);
  if (failures.length > 0) {
    const detail = failures.slice(0, 3).map((f) => `${f.path}: ${f.message}`).join("; ");
    throw new DocumentValidationError(`document in "${tableName}" does not match schema: ${detail}`);
  }
}

/** Reject access to a document whose table is outside the running component's namespace. */
function requireOwnTable(ctx: KernelContext, fullName: string): void {
  if (ctx.privileged) return;
  if (parseFullTableName(fullName).componentPath !== ctx.namespace) {
    throw new ForbiddenOperationError(`document is not in this component's namespace`);
  }
}

// ── Shard ownership guards (D3) ──────────────────────────────────────────────────────────────
// Always-on at every tier (Tier-0 SQLite, `stackbase dev`'s 8 virtual shards, fleet). Every guard
// short-circuits when the target table is unsharded (`meta.shardKey` null) OR the run is privileged
// (admin/driver) — so an app with no `.shardKey` never evaluates any of this (zero overhead), and
// the error messages are written as product copy: they name the table, the shard-key field, both
// shards, and the exact fix.

/** Route a document to its shard by the value of its shard-key field. */
function shardOfDoc(ctx: KernelContext, shardKey: string, doc: DocumentValue): ShardId {
  return shardIdForKeyValue((doc as Record<string, unknown>)[shardKey], ctx.numShards);
}

/**
 * Write guard: a document written to a sharded table must route to the running mutation's shard.
 * A no-`shardBy` ("default") mutation may not write a sharded table at all. No-op for unsharded
 * tables / privileged runs.
 */
function enforceShardWrite(ctx: KernelContext, meta: TableMeta, doc: DocumentValue, op: "insert" | "replace" | "delete"): void {
  const shardKey = meta.shardKey;
  if (!shardKey || ctx.privileged) return;
  if (!ctx.shardDeclared) {
    throw new ForbiddenOperationError(
      `table '${meta.name}' is sharded by '${shardKey}', but this mutation does not declare a shard, ` +
        `so it runs on the 'default' shard and may not write sharded tables. ` +
        `Add shardBy: '${shardKey}' to the mutation so its writes route to a single shard.`,
    );
  }
  const docShard = shardOfDoc(ctx, shardKey, doc);
  if (docShard !== ctx.shardId) {
    throw new ForbiddenOperationError(
      `table '${meta.name}' is sharded by '${shardKey}'; this mutation runs on shard ${ctx.shardId} ` +
        `but the document (${shardKey}=${JSON.stringify((doc as Record<string, unknown>)[shardKey])}) routes to shard ${docShard}. ` +
        `Perform this ${op} from a mutation whose shardBy resolves to that '${shardKey}' value ` +
        `(each mutation writes exactly one shard).`,
    );
  }
}

/** Replace guard: the shard-key field is immutable after insert (changing it would re-route the row). */
function enforceShardKeyImmutable(ctx: KernelContext, meta: TableMeta, oldDoc: DocumentValue, newDoc: DocumentValue): void {
  const shardKey = meta.shardKey;
  if (!shardKey || ctx.privileged) return;
  const before = encodeIndexKey([(oldDoc as Record<string, unknown>)[shardKey] as IndexableValue]);
  const after = encodeIndexKey([(newDoc as Record<string, unknown>)[shardKey] as IndexableValue]);
  if (!indexKeysEqual(before, after)) {
    throw new ForbiddenOperationError(
      `cannot change the shard-key field '${shardKey}' of a '${meta.name}' document ` +
        `(${JSON.stringify((oldDoc as Record<string, unknown>)[shardKey])} → ${JSON.stringify((newDoc as Record<string, unknown>)[shardKey])}): ` +
        `it is immutable after insert. Delete the document and insert a new one to move it between shards.`,
    );
  }
}

/**
 * Read-then-reject `db.get` guard: a sharded mutation may only see rows of a sharded table that
 * belong to its own shard. No-op for unsharded tables, "default"/query readers, and privileged runs.
 */
function enforceShardGet(ctx: KernelContext, meta: TableMeta, doc: DocumentValue): void {
  const shardKey = meta.shardKey;
  if (!shardKey || ctx.privileged || !ctx.shardDeclared) return;
  const docShard = shardOfDoc(ctx, shardKey, doc);
  if (docShard !== ctx.shardId) {
    throw new ForbiddenOperationError(
      `table '${meta.name}' is sharded by '${shardKey}'; this mutation runs on shard ${ctx.shardId} ` +
        `but read a document (${shardKey}=${JSON.stringify((doc as Record<string, unknown>)[shardKey])}) that lives on shard ${docShard}. ` +
        `A sharded mutation may only read rows of its own shard — read foreign-shard data from a query (queries read every shard).`,
    );
  }
}

/**
 * Scan guard: a sharded mutation may scan its OWN sharded table only via an index whose FIRST field
 * is the shard key, pinned by an `eq()` on that field to a value routing to its own shard. Any other
 * scan of a sharded table from a sharded mutation is rejected with the pinned-index rule. No-op for
 * unsharded tables, "default"/query readers, and privileged runs.
 */
function enforceShardScan(
  ctx: KernelContext,
  meta: TableMeta | undefined,
  indexSpec: { index: string; fields: readonly string[] },
  range: Array<{ field: string; operator: string; value: JSONValue }> | undefined,
): void {
  if (!ctx.shardDeclared || ctx.privileged) return;
  const shardKey = meta?.shardKey;
  if (!shardKey) return; // unsharded table — allowed; its ranges are recorded invalidation-only (D4)
  if (indexSpec.fields[0] !== shardKey) {
    throw new ForbiddenOperationError(
      `table '${meta!.name}' is sharded by '${shardKey}'; a sharded mutation may only scan it via an index ` +
        `whose first field is '${shardKey}' (index '${indexSpec.index}' starts with '${indexSpec.fields[0] ?? "(none)"}'). ` +
        `Scan foreign-shard data from a query, or define an index on ['${shardKey}', …] and pin it with .eq('${shardKey}', <its value>).`,
    );
  }
  const eq = range?.find((r) => r.field === shardKey && r.operator === "eq");
  if (!eq) {
    throw new ForbiddenOperationError(
      `table '${meta!.name}' is sharded by '${shardKey}'; a sharded mutation must pin its scan to one shard ` +
        `with .eq('${shardKey}', <value>) as the first range constraint (an open scan would cross shards). ` +
        `Scan across shards from a query instead.`,
    );
  }
  const eqShard = shardIdForKeyValue(jsonToConvex(eq.value), ctx.numShards);
  if (eqShard !== ctx.shardId) {
    throw new ForbiddenOperationError(
      `table '${meta!.name}' is sharded by '${shardKey}'; this mutation runs on shard ${ctx.shardId} ` +
        `but the scan is pinned to '${shardKey}'=${JSON.stringify(eq.value)}, which routes to shard ${eqShard}. ` +
        `A sharded mutation may only scan its own shard — read other shards from a query.`,
    );
  }
}

/** Record a scan's ranges, routing an unsharded-table read from a SHARDED mutation to the
 *  invalidation-only set (D4 split snapshot): it feeds reactivity but is NOT OCC-validated. */
function recordScanReads(ctx: KernelContext, meta: TableMeta | undefined, ranges: readonly KeyRange[]): void {
  const unvalidated = ctx.shardDeclared && !ctx.privileged && !meta?.shardKey;
  for (const range of ranges) {
    if (unvalidated) ctx.txn.recordReadUnvalidated(range);
    else ctx.txn.recordRead(range);
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
  if (value !== null) enforceShardGet(ctx, meta, value as DocumentValue);
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
  const meta = ctx.catalog.getTable(fullName);
  const converted = jsonToConvex(value) as DocumentValue;
  validateDocumentForWrite(meta, fullName, converted);
  const id = newDocumentId(tableNumber);
  const docId = encodeInternalDocumentId(id);
  const doc: DocumentValue = {
    ...converted,
    _id: docId,
    _creationTime: Number(ctx.snapshotTs),
  };
  if (meta) enforceShardWrite(ctx, meta, doc, "insert");
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
  const converted = jsonToConvex(value) as DocumentValue;
  const { _id: _omitId, _creationTime: _omitCt, ...userFields } = converted;
  validateDocumentForWrite(meta, meta.name, userFields as DocumentValue);
  const newDoc: DocumentValue = {
    ...converted,
    _id: id,
    _creationTime: (oldDoc["_creationTime"] as number) ?? Number(ctx.snapshotTs),
  };
  enforceShardKeyImmutable(ctx, meta, oldDoc as DocumentValue, newDoc);
  enforceShardWrite(ctx, meta, newDoc, "replace");
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
  if (oldDoc !== null) {
    enforceShardWrite(ctx, meta, oldDoc as DocumentValue, "delete");
    await enforceWrite(ctx, meta.name, oldDoc);
  }
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
  const tableMeta = ctx.catalog.getTable(tableName);
  enforceShardScan(ctx, tableMeta, indexSpec, spec.range);

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

  const overlay = ctx.txn.pendingIndexOverlay(indexSpec.indexId);
  const { documents, readSet } = await ctx.queryRuntime.collect(query, ctx.snapshotTs, overlay);
  recordScanReads(ctx, tableMeta, readSet.toArray());
  return JSON.stringify({ docs: documents.map((d) => convexToJson(d as Value)) });
};

const handleDbPaginate: SyscallHandler = async (ctx, argJson) => {
  const spec = JSON.parse(argJson) as QuerySpecJson & { cursor: string | null; pageSize: number; maxScan?: number };
  const tableName = ctx.privileged ? spec.table : getFullTableName(spec.table, ctx.namespace);
  const indexSpec = ctx.catalog.getIndex(tableName, spec.index);
  if (!indexSpec) throw new FunctionNotFoundError(`unknown index: ${spec.table}.${spec.index}`);
  const tableMeta = ctx.catalog.getTable(tableName);
  enforceShardScan(ctx, tableMeta, indexSpec, spec.range);

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

  const overlay = ctx.txn.pendingIndexOverlay(indexSpec.indexId);
  const { page, nextCursor, hasMore, scanCapped, readSet } = await ctx.queryRuntime.paginate(query, ctx.snapshotTs, {
    cursor: spec.cursor,
    pageSize: spec.pageSize,
    maxScan: spec.maxScan,
  }, overlay);
  recordScanReads(ctx, tableMeta, readSet.toArray());
  return JSON.stringify({ page: page.map((d) => convexToJson(d as Value)), nextCursor, hasMore, scanCapped });
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
