/**
 * `@helipod/query-engine` — turns Convex-style queries into index range scans that record
 * read sets, with post-filters and stable cursor pagination. The read side that pairs with
 * the transactor's write side to close the reactive loop.
 */
export type { ComparisonOp, FilterExpr } from "./filter";
export { evaluateFilter, evaluateFieldPath } from "./filter";

export type { IndexSpec } from "./index-manager";
export { extractIndexKey, computeIndexUpdates } from "./index-manager";

export type { ScanOrder, QueryOperator, RangeExpression, IndexInterval } from "./plan";
export { buildIndexInterval } from "./plan";

export type { Query, CollectResult, PaginatedResult } from "./query-runtime";
export { QueryRuntime } from "./query-runtime";
