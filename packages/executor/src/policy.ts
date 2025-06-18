import type { FilterExpr } from "@stackbase/query-engine";
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
