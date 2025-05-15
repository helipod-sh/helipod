/**
 * Post-filters — predicates that run on each document *after* the index scan (the residual
 * of a query that the index can't narrow). Evaluated with the canonical value comparison so
 * filtering agrees with index ordering.
 */
import { compareValues, type Value } from "@stackbase/values";
import type { DocumentValue } from "@stackbase/docstore";

export type ComparisonOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

export type FilterExpr =
  | { op: ComparisonOp; field: string; value: Value }
  | { op: "and"; clauses: FilterExpr[] }
  | { op: "or"; clauses: FilterExpr[] }
  | { op: "not"; clause: FilterExpr };

/** Resolve a dotted field path (e.g. `author.name`) against a document. */
export function evaluateFieldPath(doc: DocumentValue, path: string): Value | undefined {
  let cur: Value | undefined = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || cur instanceof ArrayBuffer) {
      return undefined;
    }
    cur = (cur as { [k: string]: Value })[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function evaluateFilter(doc: DocumentValue, expr: FilterExpr): boolean {
  switch (expr.op) {
    case "and":
      return expr.clauses.every((c) => evaluateFilter(doc, c));
    case "or":
      return expr.clauses.some((c) => evaluateFilter(doc, c));
    case "not":
      return !evaluateFilter(doc, expr.clause);
    default: {
      const fieldValue = evaluateFieldPath(doc, expr.field);
      if (fieldValue === undefined) return false; // missing field never matches a comparison
      const c = compareValues(fieldValue, expr.value);
      switch (expr.op) {
        case "eq":
          return c === 0;
        case "neq":
          return c !== 0;
        case "lt":
          return c < 0;
        case "lte":
          return c <= 0;
        case "gt":
          return c > 0;
        case "gte":
          return c >= 0;
      }
    }
  }
}
