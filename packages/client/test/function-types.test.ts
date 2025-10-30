import { describe, it, expect } from "vitest";
import type { FunctionArgs, FunctionReturnType, AnyFunctionReference } from "../src/function-types";

// Mirrors the shape codegen emits into `_generated/api.d.ts` (generate.ts's
// FUNCTION_REFERENCE_TYPE) — a structural stand-in so this package can type-check the extractors
// without depending on any app's generated output.
type GeneratedFunctionReference<
  Type extends "query" | "mutation" | "action",
  Vis extends "public" | "internal",
  Args,
  Returns,
> = {
  readonly __type: Type;
  readonly __visibility: Vis;
  readonly __args: Args;
  readonly __returns: Returns;
};

describe("FunctionArgs / FunctionReturnType", () => {
  it("extracts a declared Args/Returns pair from a generated-shaped reference (compile-time)", () => {
    type Send = GeneratedFunctionReference<"mutation", "public", { body: string }, { id: string }>;
    type Args = FunctionArgs<Send>;
    type Returns = FunctionReturnType<Send>;

    const args: Args = { body: "hi" };
    const returns: Returns = { id: "abc" };
    // @ts-expect-error — `body` must be a string
    const badArgs: Args = { body: 1 };
    void badArgs;

    expect(args.body).toBe("hi");
    expect(returns.id).toBe("abc");
  });

  it("defaults to `any` for a function with neither args nor returns declared", () => {
    type Ping = GeneratedFunctionReference<"query", "public", any, any>;
    type Args = FunctionArgs<Ping>;
    type Returns = FunctionReturnType<Ping>;

    // `any` accepts anything — this is the documented D10 gap, not a type error.
    const args: Args = { whatever: 1 };
    const returns: Returns = "whatever";
    expect(args).toBeDefined();
    expect(returns).toBe("whatever");
  });

  it("is satisfied structurally by codegen's inline FunctionReference type (no shared import needed)", () => {
    // The real generated api.d.ts defines its OWN local `FunctionReference<Type,Vis,Args,Returns>`
    // type (see generate.ts's FUNCTION_REFERENCE_TYPE) rather than importing this package's —
    // `AnyFunctionReference` must still accept it structurally.
    type LocalFunctionReference<Type extends string, Vis extends string, Args = any, Returns = any> = {
      readonly __type: Type;
      readonly __visibility: Vis;
      readonly __args: Args;
      readonly __returns: Returns;
    };
    type Fn = LocalFunctionReference<"query", "public", { id: string }, number>;
    const accepts: AnyFunctionReference<{ id: string }, number> = {} as Fn;
    void accepts;
    type Returns = FunctionReturnType<Fn>;
    const n: Returns = 42;
    expect(n).toBe(42);
  });
});
