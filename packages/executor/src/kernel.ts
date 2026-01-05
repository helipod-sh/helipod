/**
 * The kernel — the HOST side of the host/guest split. User code reaches the engine ONLY by
 * calling string syscalls (`op`, `argJson` → json), which this router dispatches to handlers
 * that touch the transaction, query engine, and index maintenance. Because the boundary is
 * pure JSON strings, the exact same handlers work when the guest is a real V8 isolate.
 */
import {
  DocumentNotFoundError,
  DocumentValidationError,
  ForbiddenOperationError,
  FunctionNotFoundError,
  IdAlreadyInUseError,
  InvalidClientIdError,
} from "@stackbase/errors";
import {
  decodeDocumentId,
  encodeInternalDocumentId,
  encodeStorageTableId,
  newDocumentId,
  getFullTableName,
  parseFullTableName,
  shardIdForKeyValue,
  DEFAULT_SHARD,
  type InternalDocumentId,
  type ShardId,
} from "@stackbase/id-codec";
import {
  indexKeyspaceId,
  keySuccessor,
  encodeIndexKey,
  indexKeysEqual,
  serializeKeyRange,
  type IndexableValue,
  type KeyRange,
  type SerializedKeyRange,
} from "@stackbase/index-key-codec";
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

/**
 * DLR Stage 2b: one `db.query` collect's metadata, captured by `handleDbQuery` for the
 * executor's DIFFABLE_RANGE passthrough-guard classification (see `executor.ts`'s
 * `classifyDiffableRange`). Only the executor can decide diffability — it alone sees both this
 * trace AND the handler's returned value — so the kernel's job is purely to record, never judge.
 */
export interface CollectTrace {
  /** The single `index:` keyspace this collect scanned (byte-identical to the entry in `readSet`). */
  keyspace: string;
  /** The scanned index-range bounds, byte-identical to the `index:` range recorded in the read set. */
  bounds: SerializedKeyRange;
  /** The USER's `.where()` filters, captured BEFORE any read-policy merge. */
  filters: FilterExpr[];
  order: "asc" | "desc";
  fields: string[];
  /**
   * This collect's documents, JSON-encoded exactly as the syscall response itself carries them
   * (same array, in fact — see `handleDbQuery`), in order. The executor's passthrough check needs
   * full per-document content, not just each doc's `_id`: a handler that ADDS/DROPS/CHANGES a
   * field while preserving `_id` order (e.g. `.map(d => ({...d, x: 1}))`) must still be declined,
   * and only a full content comparison catches that — `_id`-only equality would not.
   */
  docs: JSONValue[];
  /** True when a read policy (authz) was merged into this collect's filters — re-applying dynamic
   *  authz downstream would be unsound, so the executor declines diffability whenever this is set. */
  hadReadPolicy: boolean;
  /** True when the query declared a `.take(n)` limit. The recorded `bounds`/`docs` reflect the
   *  TRUNCATED (top-N) result, not the full matching range — a downstream differ diffing the range
   *  would (a) miss a write that should promote a new document into the top-N, and (b) never apply
   *  the limit at all, rendering every matching row instead of just the top N. The executor declines
   *  diffability whenever this is set, regardless of how faithfully the handler passes the result
   *  through. */
  hadLimit: boolean;
}

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
  /** DLR Stage 2b: when present, `handleDbQuery` pushes one `CollectTrace` per `db.query` collect
   *  onto this array. Only the top-level query-run context sets this (an empty array, populated as
   *  collects happen); facade/rule-context readers and mutations never set it, so their reads are
   *  invisible to (and can't be mistaken for) DIFFABLE_RANGE classification. */
  readonly collectTrace?: CollectTrace[];
  /**
   * In-flight syscall promises the guest initiated through this context's channel. When set (only
   * the top-level QUERY-run context arms it), {@link InlineSyscallChannel} adds every dispatched
   * syscall promise here and drops it on settle, and the executor drains any still-pending ones
   * AFTER the handler returns — BEFORE it snapshots `readRanges`/`collectTrace`. This makes a
   * query's read set include reads it genuinely made but did NOT await (a "floating"
   * `db.query(...).collect()` whose result the handler discarded): without it, `txn.reads` is
   * snapshotted before that scan's `recordScanReads` runs, the read range is lost, and the
   * subscription never invalidates on a write to a range the query actually read — a reactive-
   * correctness hole that otherwise survives only by microtask-timing luck. Empty for a
   * well-behaved query that awaits all its reads, so the drain is a no-op there.
   */
  readonly inflight?: Set<Promise<string>>;
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
    const p = this.router.dispatch(this.ctx, op, argJson);
    // DLR: track this syscall as in-flight (only when the query-run context armed the set) so the
    // executor can drain a read the handler initiated but didn't await before snapshotting the read
    // set. `drop` also settles p's rejection, so a floated-and-rejected read raises no unhandled
    // rejection. See `KernelContext.inflight`.
    const inflight = this.ctx.inflight;
    if (inflight !== undefined) {
      inflight.add(p);
      const drop = (): void => {
        inflight.delete(p);
      };
      p.then(drop, drop);
    }
    return p;
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
// Always-on at every tier (Tier-0 SQLite, `stackbase dev`'s 8 virtual shards, fleet). The one
// invariant these enforce: EVERY document has exactly ONE owning ring for its whole life — a
// sharded doc is owned by the shard of its (immutable) shard-key value; an unsharded doc is owned
// by the `"default"` shard for read-modify-write purposes. An app with no `.shardKey` never
// evaluates any of the sharded-table branches (zero overhead), and the error messages are written
// as product copy: they name the table, the shard-key field, both shards, and the exact fix.
//
// WRITE ownership is enforced for PRIVILEGED runs too (admin `_system:*` doc edits, drivers): a
// privileged write forks a doc's prev_ts chain exactly as a user write does, so it must land on the
// doc's owning ring. Privileged runs skip only the shardBy *declaration* requirement (they route
// via `RunOptions.shardId`, set by the admin/system layer from the doc's key), never ownership.
// READ guards keep the privileged bypass: admin reads are cross-shard by nature and — unlike
// writes — a read can never fork a prev_ts chain, so reading any shard from a privileged run is
// safe. (For non-privileged runs, `shardDeclared` is false ⇒ read guards already short-circuit.)

/** Route a document to its shard by the value of its shard-key field. */
function shardOfDoc(ctx: KernelContext, shardKey: string, doc: DocumentValue): ShardId {
  return shardIdForKeyValue((doc as Record<string, unknown>)[shardKey], ctx.numShards);
}

/**
 * Write guard. For a SHARDED table: the document must route to the running transaction's shard; a
 * non-privileged no-`shardBy` ("default") mutation may not write it at all. For an UNSHARDED table:
 * INSERT is fork-free (a fresh unique id, no concurrent-prev race) and allowed from any shard, but
 * REPLACE/DELETE re-modifies an existing row's chain and so must run on the owning `"default"` ring
 * — from any other ring it is an instructive error (a cross-ring RMW would lose updates). Applies to
 * privileged runs too: the admin/system layer routes an unsharded target to `"default"`, so a
 * correctly-routed privileged RMW passes; only a mis-routed one trips this.
 */
function enforceShardWrite(ctx: KernelContext, meta: TableMeta, doc: DocumentValue, op: "insert" | "replace" | "delete"): void {
  const shardKey = meta.shardKey;
  if (!shardKey) {
    // Unsharded table: owned by the default ring for RMW. INSERT is exempt; REPLACE/DELETE off the
    // default ring is rejected (blocker 2 — cross-ring global RMWs lose updates).
    if (op !== "insert" && ctx.shardId !== DEFAULT_SHARD) {
      throw new ForbiddenOperationError(
        `table '${meta.name}' is not sharded, so its documents are owned by the 'default' shard; ` +
          `a ${op} of one must run on the default shard, but this mutation runs on shard ${ctx.shardId}. ` +
          `Run this update from a mutation without shardBy (which runs on the default shard), or ` +
          `restructure so the sharded mutation only INSERTS into '${meta.name}' (inserts are allowed from any shard).`,
      );
    }
    return;
  }
  // Declaration requirement is for NON-privileged callers only; a privileged run (admin/system/
  // driver) skips the shardBy DECLARATION but is still held to shard OWNERSHIP below via the
  // `RunOptions.shardId` its caller resolved from the document's key.
  if (!ctx.privileged && !ctx.shardDeclared) {
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

  // Client-supplied _id (spec: client-supplied ids): extracted BEFORE validation, same system-field
  // discipline handleDbReplace applies. _creationTime in an insert value stays rejected as today.
  const { _id: suppliedId, ...userValue } = converted as DocumentValue & { _id?: unknown };
  validateDocumentForWrite(meta, fullName, userValue as DocumentValue);

  let id: InternalDocumentId;
  if (suppliedId !== undefined) {
    if (typeof suppliedId !== "string") throw new InvalidClientIdError(`_id must be a string`);
    let decoded: InternalDocumentId;
    try {
      decoded = decodeDocumentId(suppliedId);
    } catch (e) {
      throw new InvalidClientIdError(`_id is not a valid document id: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (decoded.tableNumber !== tableNumber) {
      const other = ctx.catalog.getTableByNumber(decoded.tableNumber);
      throw new InvalidClientIdError(
        `_id belongs to table ${other ? `"${other.name}"` : `#${decoded.tableNumber}`}, not "${table}"`,
      );
    }
    // v1 shard-safety gate (BEFORE the existence read — fail fast, and never register a
    // cross-ring-meaningless read): the supplied-_id existence check below is a snapshot read on
    // THIS transaction's own ring only. On the default `ShardedTransactor` each shard is an
    // independently-mutexed OCC domain with its own snapshot/recent-commits ring, so two
    // concurrent inserts of the SAME id on DIFFERENT rings would each see "not found" and both
    // commit — a silent duplicate identity. Restricting client-supplied ids to UNSHARDED tables
    // inserted from the DEFAULT ring makes the existence check + OCC read-set globally sound for
    // that table: every write of it lands on the one ring, so a true race loses at OCC there.
    // Sharded-table support (binding the id to the shard-key value) is deferred, not built.
    if (meta?.shardKey) {
      throw new InvalidClientIdError(
        `table "${table}" is sharded by '${meta.shardKey}'; a client-supplied _id is not supported ` +
          `on sharded tables in v1 (the id can't bind the shard-key value, and per-shard existence ` +
          `checks can't see across rings). Omit _id and let the server mint one.`,
      );
    }
    if (ctx.shardId !== DEFAULT_SHARD) {
      throw new InvalidClientIdError(
        `a client-supplied _id may only be inserted from a mutation running on the default shard ` +
          `(this mutation runs on shard ${ctx.shardId}, i.e. it declares shardBy). The existence ` +
          `check for a supplied _id is only globally sound on the default ring — insert "${table}" ` +
          `from a mutation without shardBy, or omit _id and let the server mint one.`,
      );
    }
    if ((await ctx.txn.get(decoded)) !== null) {
      throw new IdAlreadyInUseError(`a document with _id ${suppliedId} already exists in "${table}"`);
    }
    id = decoded; // deterministic: no randomness consulted on this path
  } else {
    id = newDocumentId(tableNumber);
  }
  const docId = encodeInternalDocumentId(id); // canonical re-encoding either way
  const doc: DocumentValue = {
    ...(userValue as DocumentValue),
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
  // Captured BEFORE any read-policy merge below (DLR 2b): the diffable-range trace must carry
  // the USER's own filters, never the dynamic authz predicate the merge appends.
  const userFilters = query.filters ?? [];

  const hadReadPolicy = !ctx.privileged && !!ctx.getRuleContext && !!ctx.policyRegistry.get(tableName)?.read;
  if (hadReadPolicy) {
    const policy = ctx.policyRegistry.get(tableName)!;
    query.filters = mergeReadPolicy(query.filters, await resolveReadPolicy(policy, await ctx.getRuleContext!(), tableName, ctx.relationRegistry));
  }

  const overlay = ctx.txn.pendingIndexOverlay(indexSpec.indexId);
  const { documents, readSet } = await ctx.queryRuntime.collect(query, ctx.snapshotTs, overlay);
  const scannedRanges = readSet.toArray();
  recordScanReads(ctx, tableMeta, scannedRanges);
  // Same encoding either consumer needs — computed once and shared by both the syscall response
  // below and (when tracing) the DLR 2b collect trace, so the trace is byte-identical to what the
  // handler actually receives.
  const docsJson = documents.map((d) => convexToJson(d as Value));

  if (ctx.collectTrace) {
    // DLR 2b: record this collect's metadata for the executor's DIFFABLE_RANGE classification.
    // Only a clean single-index-range scan is recordable — if this collect's own read set carries
    // more than one `index:` range (should not happen for a single-index `collect()`, but stay
    // conservative per Task 1's verified single-range invariant), skip the trace entry entirely so
    // the executor's `trace.length !== 1` guard declines diffability for the whole run.
    const indexRanges = scannedRanges.filter((r) => r.keyspace.startsWith("index:"));
    if (indexRanges.length === 1) {
      ctx.collectTrace.push({
        keyspace: indexRanges[0]!.keyspace,
        bounds: serializeKeyRange(indexRanges[0]!),
        filters: userFilters,
        order: spec.order ?? "asc",
        fields: indexSpec.fields,
        docs: docsJson,
        hadReadPolicy,
        hadLimit: spec.limit !== undefined,
      });
    }
  }

  return JSON.stringify({ docs: docsJson });
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
