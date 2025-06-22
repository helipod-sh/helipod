import { evaluateFilter, type FilterExpr } from "@stackbase/query-engine";
import type { Value } from "@stackbase/values";
import type { GuestDatabaseReader } from "./guest";
import type { ComponentContext } from "./executor";

export interface Scope { type: string; id: string }

/** The authorization surface a policy sees. Backed by the composed auth+authz facades. */
export interface RuleAuth {
  userId: string | null;
  identity: string | null;
  can(permission: string, scope?: Scope): Promise<boolean>;
  roles(scope?: Scope): Promise<string[]>;
  scopesWith(permission: string, type?: string): Promise<string[]>;
}

/** Context a policy receives. `db` is a read-only, txn-bound reader for relation lookups. */
export interface RuleContext { auth: RuleAuth; db: GuestDatabaseReader }

export interface FieldOps {
  eq?: Value; ne?: Value; lt?: Value; lte?: Value; gt?: Value; gte?: Value;
  in?: Value[]; notIn?: Value[]; isNull?: boolean;
}

/**
 * A field-level predicate. Logical forms use the reserved keys AND/OR/NOT; otherwise every key is a
 * field mapped to a bare value (→ eq) or a `FieldOps` object. (A field literally named AND/OR/NOT is
 * not expressible — use nested logical forms.)
 */
export type WhereInput =
  | { AND: WhereInput[] }
  | { OR: WhereInput[] }
  | { NOT: WhereInput }
  | { [field: string]: Value | FieldOps };

export type PolicyPredicate = WhereInput | boolean | undefined;

export interface TablePolicy {
  read?: (ctx: RuleContext) => PolicyPredicate | Promise<PolicyPredicate>;
  write?: (ctx: RuleContext, row: Record<string, unknown>) => boolean | Promise<boolean>;
}

export type PolicyRegistry = ReadonlyMap<string, TablePolicy>;

/** A component's contribution to the rule-context (e.g. authz contributes `{ auth }`). */
export interface PolicyContextProvider {
  readonly namespace: string;
  readonly build: (cctx: ComponentContext) => object | Promise<object>;
}

const ALWAYS_TRUE = Object.freeze({ op: "and" as const, clauses: Object.freeze([]) as unknown as FilterExpr[] });
const ALWAYS_FALSE = Object.freeze({ op: "or" as const, clauses: Object.freeze([]) as unknown as FilterExpr[] });

/** Compile a policy predicate to a post-filter. Returns null when the policy adds no restriction. */
export function compileWhere(where: PolicyPredicate): FilterExpr | null {
  if (where === undefined || where === true) return null;
  if (where === false) return ALWAYS_FALSE;
  return compileNode(where);
}

function compileNode(node: WhereInput): FilterExpr {
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.AND)) return { op: "and", clauses: (n.AND as WhereInput[]).map(compileNode) };
  if (Array.isArray(n.OR)) return { op: "or", clauses: (n.OR as WhereInput[]).map(compileNode) };
  if (n.NOT !== undefined) return { op: "not", clause: compileNode(n.NOT as WhereInput) };
  const clauses: FilterExpr[] = [];
  for (const [field, cond] of Object.entries(n)) clauses.push(compileField(field, cond));
  if (clauses.length === 0) return ALWAYS_TRUE;
  return clauses.length === 1 ? clauses[0]! : { op: "and", clauses };
}

/** A plain scalar/array/null/ArrayBuffer is a bare `eq`; a plain object is a `FieldOps` bag. */
function isFieldOps(cond: unknown): cond is FieldOps {
  return cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof ArrayBuffer);
}

function compileField(field: string, cond: unknown): FilterExpr {
  if (!isFieldOps(cond)) return { op: "eq", field, value: cond as Value };
  const ops = cond;
  if ("some" in ops || "is" in ops)
    throw new Error(`relation clauses ("some"/"is") are only valid at the top level of a policy (resolved by resolveWhere); nested relations are not supported`);
  const clauses: FilterExpr[] = [];
  if ("eq" in ops) clauses.push({ op: "eq", field, value: ops.eq as Value });
  if ("ne" in ops) clauses.push({ op: "neq", field, value: ops.ne as Value });
  if ("lt" in ops) clauses.push({ op: "lt", field, value: ops.lt as Value });
  if ("lte" in ops) clauses.push({ op: "lte", field, value: ops.lte as Value });
  if ("gt" in ops) clauses.push({ op: "gt", field, value: ops.gt as Value });
  if ("gte" in ops) clauses.push({ op: "gte", field, value: ops.gte as Value });
  if (ops.in !== undefined) clauses.push({ op: "or", clauses: ops.in.map((v) => ({ op: "eq", field, value: v })) });
  if (ops.notIn !== undefined) clauses.push({ op: "and", clauses: ops.notIn.map((v) => ({ op: "neq", field, value: v })) });
  if ("isNull" in ops) clauses.push({ op: ops.isNull ? "eq" : "neq", field, value: null });
  if (clauses.length === 0) return ALWAYS_TRUE;
  return clauses.length === 1 ? clauses[0]! : { op: "and", clauses };
}

/** AND-merge a compiled read policy into a query's existing post-filters. */
export function mergeReadPolicy(existing: FilterExpr[] | undefined, policyExpr: FilterExpr | null): FilterExpr[] {
  if (!policyExpr) return existing ?? [];
  return [...(existing ?? []), policyExpr];
}

export async function evalReadPolicy(policy: TablePolicy, rc: RuleContext): Promise<FilterExpr | null> {
  if (!policy.read) return null;
  return compileWhere(await policy.read(rc));
}

export async function evalWritePolicy(
  policy: TablePolicy, rc: RuleContext, row: Record<string, unknown>,
): Promise<boolean> {
  if (!policy.write) return true;
  return await policy.write(rc, row);
}

// ─── Relation predicate resolver (Layer 2) ───────────────────────────────────

export type RelationClause = { some: WhereInput } | { is: WhereInput };

export interface RelationRegistry {
  /** parentTable → relationName → { child table, back-reference field }. */
  toMany: ReadonlyMap<string, ReadonlyMap<string, { table: string; field: string }>>;
  /** parentTable → fieldName → target table (derived from v.id fields). */
  toOne: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface ResolveCtx {
  parentTable: string;
  relations: RelationRegistry;
  db: GuestDatabaseReader;
}

function isRelationClause(cond: unknown): cond is RelationClause {
  return cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof ArrayBuffer)
    && ("some" in cond || "is" in cond);
}

async function resolveSome(relName: string, leaf: WhereInput, ctx: ResolveCtx): Promise<FilterExpr> {
  const rel = ctx.relations.toMany.get(ctx.parentTable)?.get(relName);
  if (!rel) throw new Error(`unknown relation "${relName}" on table "${ctx.parentTable}"`);
  const leafExpr = compileWhere(leaf);
  const rows = await ctx.db.query(rel.table, "by_creation").collect();
  const ids = new Set<Value>();
  for (const row of rows) {
    if (leafExpr === null || evaluateFilter(row, leafExpr)) {
      const ref = (row as Record<string, unknown>)[rel.field];
      if (ref !== undefined) ids.add(ref as Value);
    }
  }
  return compileWhere({ _id: { in: [...ids] } }) ?? ALWAYS_FALSE;
}

async function resolveIs(fieldName: string, leaf: WhereInput, ctx: ResolveCtx): Promise<FilterExpr> {
  const targetTable = ctx.relations.toOne.get(ctx.parentTable)?.get(fieldName);
  if (!targetTable) throw new Error(`field "${fieldName}" is not a reference (v.id) on table "${ctx.parentTable}"`);
  const leafExpr = compileWhere(leaf);
  const rows = await ctx.db.query(targetTable, "by_creation").collect();
  const ids = new Set<Value>();
  for (const row of rows) {
    if (leafExpr === null || evaluateFilter(row, leafExpr)) {
      const id = (row as Record<string, unknown>)._id;
      if (id !== undefined) ids.add(id as Value);
    }
  }
  return compileWhere({ [fieldName]: { in: [...ids] } }) ?? ALWAYS_FALSE;
}

async function resolveClause(key: string, cond: unknown, ctx: ResolveCtx): Promise<FilterExpr> {
  if (isRelationClause(cond)) {
    if ("some" in cond) return resolveSome(key, cond.some, ctx);
    return resolveIs(key, cond.is, ctx);
  }
  return compileWhere({ [key]: cond } as WhereInput) ?? ALWAYS_TRUE;
}

async function resolveNode(node: WhereInput, ctx: ResolveCtx): Promise<FilterExpr> {
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.AND)) return { op: "and", clauses: await Promise.all((n.AND as WhereInput[]).map((c) => resolveNode(c, ctx))) };
  if (Array.isArray(n.OR)) return { op: "or", clauses: await Promise.all((n.OR as WhereInput[]).map((c) => resolveNode(c, ctx))) };
  if (n.NOT !== undefined) return { op: "not", clause: await resolveNode(n.NOT as WhereInput, ctx) };
  const clauses: FilterExpr[] = [];
  for (const [key, cond] of Object.entries(n)) clauses.push(await resolveClause(key, cond, ctx));
  if (clauses.length === 0) return ALWAYS_TRUE;
  return clauses.length === 1 ? clauses[0]! : { op: "and", clauses };
}

/** Async superset of compileWhere: resolves relation clauses via semi-join, then behaves like compileWhere. */
export async function resolveWhere(where: PolicyPredicate, ctx: ResolveCtx): Promise<FilterExpr | null> {
  if (where === undefined || where === true) return null;
  if (where === false) return ALWAYS_FALSE;
  return resolveNode(where, ctx);
}

/** Read-path entry: resolve a table's read policy (with relation clauses) to a post-filter. */
export async function resolveReadPolicy(
  policy: TablePolicy, rc: RuleContext, parentTable: string, relations: RelationRegistry,
): Promise<FilterExpr | null> {
  if (!policy.read) return null;
  return resolveWhere(await policy.read(rc), { parentTable, relations, db: rc.db });
}
