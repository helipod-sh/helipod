/**
 * Function definitions — the Convex-compatible authoring surface. `query`/`mutation`/`action`
 * tag a handler with its UDF type; the executor sets up the right context and profile.
 */
import type { UdfType } from "./profile";
import type { MutationCtx, QueryCtx } from "./guest";

export interface RegisteredFunction {
  type: UdfType;
  handler: (ctx: unknown, args: unknown) => unknown | Promise<unknown>;
}

export function query<Args = unknown, Output = unknown>(def: {
  handler: (ctx: QueryCtx, args: Args) => Output | Promise<Output>;
}): RegisteredFunction {
  return { type: "query", handler: def.handler as RegisteredFunction["handler"] };
}

export function mutation<Args = unknown, Output = unknown>(def: {
  handler: (ctx: MutationCtx, args: Args) => Output | Promise<Output>;
}): RegisteredFunction {
  return { type: "mutation", handler: def.handler as RegisteredFunction["handler"] };
}

export function action<Args = unknown, Output = unknown>(def: {
  handler: (ctx: unknown, args: Args) => Output | Promise<Output>;
}): RegisteredFunction {
  return { type: "action", handler: def.handler as RegisteredFunction["handler"] };
}
