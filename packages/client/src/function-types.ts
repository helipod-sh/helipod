/**
 * `FunctionArgs`/`FunctionReturnType` — extract the typed args/return generics from a
 * codegen-generated function reference (see `@helipod/codegen`'s `FUNCTION_REFERENCE_TYPE`,
 * emitted verbatim into every app's `_generated/api.d.ts` as `FunctionReference<Type, Vis, Args,
 * Returns>`). The `__args`/`__returns` fields are phantom — they exist purely at the type level
 * (the actual runtime value behind e.g. `api.messages.send` is the untyped `anyApi` proxy from
 * `./api.ts`) — so these generics operate structurally on any type carrying them, without this
 * package importing the app's generated types.
 *
 * This is D10 (docs/superpowers/specs/2025-10-16-optimistic-updates-design.md): `returns`
 * validators are now threaded through codegen to a real `Returns` type (`functions.ts`'s
 * `returnsJson` -> `validatorToTsType` -> the `generate.ts` `returnsType` slot); a function
 * without a `returns` declaration stays `any` (the documented gap — see the executor's
 * `returnsJson` doc for the enforcement follow-on). Consumed by the typed optimistic-updates
 * store and `useQuery`/`useMutation`/`useAction`.
 */
export interface AnyFunctionReference<Args = any, Returns = any> {
  readonly __args: Args;
  readonly __returns: Returns;
}

/** The argument type a generated function reference expects (`any` if the function declares no `args`). */
export type FunctionArgs<FuncRef extends AnyFunctionReference> = FuncRef["__args"];

/**
 * The value a generated function reference resolves with (`any` if the function declares no
 * `returns` — D10's documented gap; migrants add `returns` incrementally to narrow it).
 */
export type FunctionReturnType<FuncRef extends AnyFunctionReference> = FuncRef["__returns"];
