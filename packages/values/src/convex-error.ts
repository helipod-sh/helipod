import type { Value } from "./value";

/**
 * An application error thrown from inside a query/mutation/action and surfaced to the
 * client with its structured `data` payload intact (Convex-compatible). Distinct from
 * `@stackbase/errors` (engine errors) — this one is part of the user-facing function API.
 */
export class ConvexError<TData extends Value = Value> extends Error {
  override name = "ConvexError";
  readonly data: TData;

  constructor(data: TData) {
    super(typeof data === "string" ? data : JSON.stringify(data));
    this.data = data;
  }
}
