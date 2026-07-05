/**
 * Function definitions — the Convex-compatible authoring surface. `query`/`mutation`/`action`
 * tag a handler with its UDF type; the executor sets up the right context and profile. An
 * optional `args` validator (a `PropertyValidators` record of `v.*`) is stored on the returned
 * function so the executor can validate incoming call args and codegen can type the client api.
 */
import type { UdfType } from "./profile";
import type { MutationCtx, QueryCtx } from "./guest";
import {
  v,
  type PropertyValidators,
  type AnyValidator,
  type ValidatorJSON,
  type ObjectType,
  type Validator,
} from "@helipod/values";

/**
 * A validator over an arbitrary return type `T`. Deliberately constrained to `"required"` —
 * `OptionalValidator.toJSON()` delegates to its inner validator (values/validator.ts), so a
 * top-level `v.optional(...)` here would silently lose its optionality in the codegen'd JSON
 * (`Returns` would come out as `T`, not `T | undefined`). Express "may be undefined" with
 * `v.union(v.string(), v.null())` (or make the value itself nullable) instead — `v.optional`
 * is only meaningful as an *object field* modifier, not as a return-type wrapper.
 */
type ReturnsValidator<T> = Validator<T, "required">;

/** A mutation's shard selector: a validated arg NAME (common case) or a resolver over the args. */
export type ShardBy = string | ((args: any) => unknown);

export interface RegisteredFunction {
  type: UdfType;
  handler: (ctx: unknown, args: unknown) => unknown | Promise<unknown>;
  /** Live validator for the call args (`v.object(args)`), when the function declares `args`. */
  argsValidator?: AnyValidator;
  /** `argsValidator.toJSON()`, for codegen to emit the typed `FunctionReference`. */
  argsJson?: ValidatorJSON;
  /**
   * Live validator for the return value, when the function declares `returns`. Mirrors
   * `argsValidator`/`argsJson` exactly — see `build()`. NO runtime enforcement this slice (typing
   * only, threaded through codegen to the generated `FunctionReference`'s `Returns` slot);
   * enforcing it against the actual handler result is the argument-validation slice's sibling
   * follow-on (same `DocumentValidationError`-style shape, applied to the return value instead of
   * the call args).
   */
  returnsValidator?: AnyValidator;
  /** `returnsValidator.toJSON()`, for codegen to emit the typed `FunctionReference`'s `Returns` slot. */
  returnsJson?: ValidatorJSON;
  /**
   * (Mutations only) which shard this mutation runs on — an arg name whose (validated) value is
   * routed, or a resolver `(args) => value` producing the value to route. Absent → the mutation
   * runs on the `"default"` shard (today's behavior; its writes to sharded tables error). The
   * executor resolves this to a `ShardId` before opening the transaction (see `InlineUdfExecutor`).
   */
  shardBy?: ShardBy;
}

/** Build a `RegisteredFunction`, attaching an args validator when the def declares `args`. */
function build(type: UdfType, def: unknown): RegisteredFunction {
  const handler = (typeof def === "function" ? def : (def as { handler: unknown }).handler) as RegisteredFunction["handler"];
  const rf: RegisteredFunction = { type, handler };
  if (typeof def === "object" && def !== null && "args" in def) {
    const args = (def as { args?: PropertyValidators }).args;
    if (args) {
      const argsValidator = v.object(args);
      rf.argsValidator = argsValidator;
      rf.argsJson = argsValidator.toJSON();
    }
  }
  if (typeof def === "object" && def !== null && "returns" in def) {
    const returns = (def as { returns?: AnyValidator }).returns;
    if (returns) {
      rf.returnsValidator = returns;
      rf.returnsJson = returns.toJSON();
    }
  }
  if (type === "mutation" && typeof def === "object" && def !== null && "shardBy" in def) {
    const shardBy = (def as { shardBy?: ShardBy }).shardBy;
    if (shardBy !== undefined) rf.shardBy = shardBy;
  }
  return rf;
}

type QueryDef<Args, Output> =
  | { handler: (ctx: QueryCtx, args: Args) => Output | Promise<Output>; returns?: ReturnsValidator<Output> }
  | ((ctx: QueryCtx, args: Args) => Output | Promise<Output>);

export function query<A extends PropertyValidators, Output = unknown>(
  def: {
    args: A;
    returns?: ReturnsValidator<Output>;
    handler: (ctx: QueryCtx, args: ObjectType<A>) => Output | Promise<Output>;
  },
): RegisteredFunction;
export function query<Args = unknown, Output = unknown>(def: QueryDef<Args, Output>): RegisteredFunction;
export function query(def: unknown): RegisteredFunction {
  return build("query", def);
}

type MutationDef<Args, Output> =
  | {
      handler: (ctx: MutationCtx, args: Args) => Output | Promise<Output>;
      shardBy?: ShardBy;
      returns?: ReturnsValidator<Output>;
    }
  | ((ctx: MutationCtx, args: Args) => Output | Promise<Output>);

export function mutation<A extends PropertyValidators, Output = unknown>(
  def: {
    args: A;
    shardBy?: string | ((args: ObjectType<A>) => unknown);
    returns?: ReturnsValidator<Output>;
    handler: (ctx: MutationCtx, args: ObjectType<A>) => Output | Promise<Output>;
  },
): RegisteredFunction;
export function mutation<Args = unknown, Output = unknown>(def: MutationDef<Args, Output>): RegisteredFunction;
export function mutation(def: unknown): RegisteredFunction {
  return build("mutation", def);
}

type ActionDef<Args, Output> =
  | { handler: (ctx: unknown, args: Args) => Output | Promise<Output>; returns?: ReturnsValidator<Output> }
  | ((ctx: unknown, args: Args) => Output | Promise<Output>);

export function action<A extends PropertyValidators, Output = unknown>(
  def: {
    args: A;
    returns?: ReturnsValidator<Output>;
    handler: (ctx: unknown, args: ObjectType<A>) => Output | Promise<Output>;
  },
): RegisteredFunction;
export function action<Args = unknown, Output = unknown>(def: ActionDef<Args, Output>): RegisteredFunction;
export function action(def: unknown): RegisteredFunction {
  return build("action", def);
}

type HttpActionDef =
  | { handler: (ctx: unknown, request: Request) => Response | Promise<Response> }
  | ((ctx: unknown, request: Request) => Response | Promise<Response>);

/**
 * `httpAction` — an action whose I/O is a raw Web `Request` -> `Response` (instead of JSON
 * args -> value). Same non-deterministic context as `action` (runQuery/runMutation/runAction,
 * native fetch/clock; NO ctx.db); routed by the public HTTP router (see `./http-router.ts`).
 */
export function httpAction(def: HttpActionDef): RegisteredFunction {
  const handler = typeof def === "function" ? def : def.handler;
  return { type: "httpAction", handler: handler as RegisteredFunction["handler"] };
}
