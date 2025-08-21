# Argument Validation (D5 phase 2) — Design Spec

**Date:** 2025-08-12
**Status:** Approved (design)
**Slice:** D5 phase 2 — the function-argument half of runtime validation. Phase 1 (document validation) shipped 2025-08-12 (`docs/superpowers/specs/2025-08-12-runtime-validation-design.md`, commits `c22a142..a863e42`).

## Problem

The engine validates *documents* on write but never validates a function's *arguments*. `mutation`/`query`/`action` take only a handler — there is no way to declare the shape of a call's args, so a client (or another function, or a scheduled job) can pass wrong-typed, missing, or extra args and the handler runs anyway. This is the D5 gap `@stackbase/test` surfaced (`[[test-harness-slice-shipped]]`), the argument half.

Convex closes this with `mutation({ args: { … }, handler })`: the `args` validator (a) rejects bad calls at runtime with an `ArgumentValidationError`, (b) *types* the handler's `args` parameter, and (c) *types* the generated client `api` so `client.mutation(api.foo, {…})` is checked at compile time. We reimplement the same, clean-room, reusing the validator infrastructure the document-validation slice already built.

## Goals

1. **Authoring surface** — `mutation`/`query`/`action` accept an optional `args` (a `PropertyValidators` record of `v.*`, Convex-style). Opt-in: a function without `args` behaves exactly as today (accepts anything).
2. **Runtime enforcement** — before a handler runs, incoming args are validated against the declared validator; a mismatch throws `ArgumentValidationError` (already defined in `@stackbase/errors`; a `UserError`, `retryable:false`, code `ARGUMENT_VALIDATION`, HTTP 400) and the handler never executes.
3. **Handler-side type inference** — the handler's `args` parameter is inferred from the validators (no manual annotation), reusing the existing `ObjectType<F>`/`Infer<V>` helpers in `@stackbase/values`.
4. **Codegen** — the generated `api.d.ts` types each `FunctionReference`'s args from the validator, so client-side calls are compile-time checked. This is the load-bearing typed-`api` DX per CLAUDE.md.

## Non-goals (YAGNI)

- **Returns validation.** No `returns` surface; `returnsType` stays `undefined` in the manifest. Separate future follow-up.
- **`httpAction` args.** Its I/O is a raw `Request`, not JSON args — excluded from the surface and from enforcement.
- **Argument coercion / transformation.** Validate-only; args pass through unchanged.
- **Per-argument custom error messages.** The error lists path failures, same format as document validation.

## Design

All three deliverables are cheap wiring because the primitives already exist: `Validator.check()` + strict `v.object` (runtime, from the doc-validation slice), `Infer<V>`/`ObjectType<F>` (types, `packages/values/src/validator.ts:63,70-73`), `validatorToTsType` (codegen, exported from `@stackbase/codegen`), and `ArgumentValidationError` (`@stackbase/errors`).

### 1. Authoring surface — `packages/executor/src/functions.ts`

`RegisteredFunction` gains two optional fields:

```ts
export interface RegisteredFunction {
  type: UdfType;
  handler: (ctx: unknown, args: unknown) => unknown | Promise<unknown>;
  argsValidator?: AnyValidator;   // live v.object(args) — used by the executor at runtime
  argsJson?: ValidatorJSON;       // args.toJSON() — used by codegen to emit argsType
}
```

`query`/`mutation`/`action` accept a new def variant `{ args?: PropertyValidators; handler }`. When `args` is present:
- build `const argsValidator = v.object(args)` once at definition time,
- store `argsValidator` and `argsValidator.toJSON()` on the returned `RegisteredFunction`,
- infer the handler's `args` parameter type from `args` via `ObjectType<F>` so `(ctx, args) => …` types `args` with no annotation.

The bare-function form and the `{ handler }`-only form are unchanged (no `argsValidator`, no `argsJson`). `httpAction` is untouched — it has no `args`.

Generic shape (mirrors Convex; `ObjectType`/`Infer` already exist):

```ts
export function mutation<A extends PropertyValidators, Output = unknown>(
  def: { args: A; handler: (ctx: MutationCtx, args: ObjectType<A>) => Output | Promise<Output> },
): RegisteredFunction;
export function mutation<Args = unknown, Output = unknown>(
  def: MutationDef<Args, Output>,  // existing { handler } | bare-fn form
): RegisteredFunction;
```

(Overloads so the existing untyped form still compiles; `query`/`action` identical, with their own ctx types.)

### 2. Runtime enforcement — `packages/executor/src/executor.ts`

At the **top of `run()`** (before the `httpAction`/`action` early-dispatch and before any transaction setup), one uniform guard:

```ts
async run<T>(fn: RegisteredFunction, args: unknown, options: RunOptions = {}): Promise<UdfResult<T>> {
  if (fn.type !== "httpAction" && fn.argsValidator) {
    const failures = validate(fn.argsValidator, args as Value);
    if (failures.length > 0) {
      const detail = failures.slice(0, 3).map((f) => `${f.path}: ${f.message}`).join("; ");
      throw new ArgumentValidationError(
        `arguments to "${options.path ?? "<anonymous>"}" do not match validator: ${detail}`,
      );
    }
  }
  if (fn.type === "httpAction") return this.runActionFn<T>(fn, args, options, "httpAction");
  // …unchanged…
}
```

- `args` at `run()` entry is already a `Value` — the runtime boundary (`runtime.ts`, `invoke`) `jsonToConvex`es args before calling `executor.run`. No conversion needed here.
- This single site covers **every** call path: direct `runtime.run`, client mutation/query/action, `ctx.runQuery/runMutation/runAction` re-entrancy, and scheduler/cron-dispatched calls — because they all funnel through `executor.run`.
- Strictness matches document validation: `v.object` rejects extra keys, missing required keys, and wrong types. Optional fields (`v.optional`) may be omitted.
- Throwing before transaction setup means a bad-args call consumes no writer slot and cannot partially execute.
- `validate(validator, value)` is the same helper `kernel.ts`'s `validateDocumentForWrite` uses (returns `ValidationFailure[]`).

### 3. Codegen — `packages/cli/src/project.ts`

In `loadProject`, where the manifest entry is built (currently `functions.push({ name, type: value.type, visibility: "public" })`, line ~88), populate `argsType`:

```ts
functions.push({
  name,
  type: value.type,
  visibility: "public",
  argsType: value.argsJson ? validatorToTsType(value.argsJson) : undefined,
});
```

`generate.ts` already emits `FunctionReference<"${f.type}", "${visibility}", ${f.argsType ?? "any"}, ${f.returnsType ?? "any"}>` — no change there. Result: a function with `args` gets a typed `api` reference (e.g. `{ conversationId: Id<"conversations">; body: string }`); a function without stays `any` (unchanged DX for existing code). `validatorToTsType` is already imported-available from `@stackbase/codegen`.

### Error surface

`ArgumentValidationError` (existing): `UserError`, `httpStatus` 400, `retryable` false, `code` `"ARGUMENT_VALIDATION"`. Message: `arguments to "<path>" do not match validator: <path>: <msg>; …` (first 3 failures). It surfaces to the caller as a 400 over HTTP / a rejected client promise, and — because it is non-retryable — a scheduled function called with bad args dead-letters on the first attempt (via the scheduler fail-fast that shipped in `f2ed194`), rather than burning retries.

## Build order (each an independently testable task)

1. **`RegisteredFunction` fields + `functions.ts` surface** — add `argsValidator`/`argsJson`; add the typed `{ args, handler }` overload to `query`/`mutation`/`action`, building `v.object(args)` and storing it + its JSON. Unit test: a def with `args` carries a live validator + JSON; the bare/`{handler}` forms carry neither; handler `args` type is inferred (a `// @ts-expect-error` on a wrong field access proves inference).
2. **Executor enforcement** — the `run()` guard. Unit tests over the executor: valid args pass; wrong-type / missing-required / extra-key each throw `ArgumentValidationError` with a path in the message; a function with no validator accepts arbitrary args; an `action` with `args` is validated too (proves the guard runs before the action early-dispatch).
3. **Codegen `argsType`** — populate the manifest field in `project.ts`; a codegen test asserts the generated `api.d.ts` contains the derived object type for a function with `args` and `any` for one without.
4. **E2E through `stackbase dev`** (`packages/cli/test/`) — a real server + real client: a well-typed call succeeds; a call with a wrong-typed arg is rejected with the `ARGUMENT_VALIDATION` message over the wire. Follows the `[[e2e-through-shipped-entrypoint]]` rule — a cross-package feature needs a test through the real entrypoint, not just executor unit tests.
5. **Backward-compat audit + docs** — grep every `mutation(`/`query(`/`action(` in `packages/`, `components/`, `examples/`; confirm none breaks (all omit `args`, so validation is inert). Add an `args` example to `docs/enduser/` (functions/validation doc). Expected outcome: empty audit, mirroring the document-validation slice.

## Testing strategy

- **Executor unit** (`packages/executor/test/`): the enforcement matrix in Task 2.
- **functions.ts unit**: the surface + inference in Task 1.
- **Codegen unit** (`packages/codegen/test/` or `packages/cli/test/`): `argsType` emission in Task 3.
- **E2E** (`packages/cli/test/`): the real-server round-trip in Task 4.
- Full monorepo `bun run build && bun run typecheck && bun run test` green at the end.

## Backward compatibility

Validation is **opt-in per function**: it runs only when a function declares `args`. Every function that exists today omits `args`, so this change is inert for all of them (same empty-audit result the document slice saw). No existing test should need to change except any that deliberately assert the *old* "no arg validation" behavior (none known — the doc-validation audit found the arg surface entirely unused). Adding `args` to a function is a future, deliberate, per-function opt-in.

## Risks

- **Over-strict rejection of an existing caller.** Mitigated by opt-in — nothing is validated until someone adds `args`. The audit (Task 5) confirms no current function opts in.
- **Type-overload ambiguity** — the typed `{ args, handler }` overload must not break inference for the existing untyped `{ handler }` / bare-fn forms. Task 1's `ts-expect-error` tests and the full `typecheck` gate guard this; if overload resolution proves fragile, fall back to a single signature that accepts `args?` and infers `ObjectType<A>` when present.
- **Enforcement-site correctness for actions** — actions early-dispatch in `run()`; the guard is placed *above* that dispatch so it is not skipped. Task 2 explicitly tests an action with `args`.

## Related

- `[[runtime-validation-shipped]]` — phase 1 (documents); reused `validate`/`v.object`/`Validator.check`.
- `[[test-harness-slice-shipped]]` — surfaced the D5 gap.
- `[[e2e-through-shipped-entrypoint]]`, `[[feedback-decide-decisively]]`.
