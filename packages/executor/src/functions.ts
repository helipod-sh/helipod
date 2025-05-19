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

type QueryDef<Args, Output> =
  | { handler: (ctx: QueryCtx, args: Args) => Output | Promise<Output> }
  | ((ctx: QueryCtx, args: Args) => Output | Promise<Output>);

export function query<Args = unknown, Output = unknown>(def: QueryDef<Args, Output>): RegisteredFunction {
  const handler = typeof def === "function" ? def : def.handler;
  return { type: "query", handler: handler as RegisteredFunction["handler"] };
}

type MutationDef<Args, Output> =
  | { handler: (ctx: MutationCtx, args: Args) => Output | Promise<Output> }
  | ((ctx: MutationCtx, args: Args) => Output | Promise<Output>);

export function mutation<Args = unknown, Output = unknown>(def: MutationDef<Args, Output>): RegisteredFunction {
  const handler = typeof def === "function" ? def : def.handler;
  return { type: "mutation", handler: handler as RegisteredFunction["handler"] };
}

type ActionDef<Args, Output> =
  | { handler: (ctx: unknown, args: Args) => Output | Promise<Output> }
  | ((ctx: unknown, args: Args) => Output | Promise<Output>);

export function action<Args = unknown, Output = unknown>(def: ActionDef<Args, Output>): RegisteredFunction {
  const handler = typeof def === "function" ? def : def.handler;
  return { type: "action", handler: handler as RegisteredFunction["handler"] };
}
