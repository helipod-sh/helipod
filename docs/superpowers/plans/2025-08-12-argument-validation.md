# Argument Validation (D5 phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `mutation`/`query`/`action` `{ args, handler }` surface that validates a function's incoming arguments at runtime (`ArgumentValidationError` on mismatch), infers the handler's `args` type from the validator, and types the generated client `api`.

**Architecture:** Reuse the validator infrastructure the document-validation slice already shipped. `functions.ts` builds a live `v.object(args)` validator at definition time and stores it (plus its JSON) on the `RegisteredFunction`. The executor's `run()` validates incoming args against it before any handler dispatch, throwing `ArgumentValidationError`. Codegen reads the stored JSON to emit a typed `FunctionReference` in `api.d.ts`. Opt-in: a function without `args` is unchanged.

**Tech Stack:** TypeScript, Bun (package manager + runtime), Turborepo, vitest (under Node), `@stackbase/values` (validators), `@stackbase/errors` (error taxonomy), `@stackbase/codegen` (typed api emit).

## Global Constraints

- **Opt-in per function.** Validation runs ONLY when a function declares `args`. A function with no `args` accepts anything — identical to today. This must hold; the backward-compat audit (Task 5) confirms it.
- **`httpAction` is excluded.** Its I/O is a raw `Request`, not JSON args. No `args` surface, no enforcement.
- **Validate-only, no coercion.** Args pass through unchanged; validation only accepts or rejects.
- **No returns validation.** `returnsType` stays `undefined` — out of scope.
- **Reuse, do not reinvent.** Use `@stackbase/values` exports `v.object`, `validate`, `ObjectType<F>`, `Infer<V>`, `PropertyValidators`, `AnyValidator`, `ValidatorJSON`; `@stackbase/codegen` export `validatorToTsType`; `@stackbase/errors` export `ArgumentValidationError`. All already exist and are exported.
- **`ArgumentValidationError`** is a `UserError`: `httpStatus` 400, `retryable` false, `code` `"ARGUMENT_VALIDATION"`. Error message format: `arguments to "<path>" do not match validator: <path>: <msg>; …` (first 3 failures joined by `"; "`), mirroring the document-validation message shape.
- **Tests run under Node/vitest.** `globalThis.Bun` is undefined in tests — no Bun-API assertions.
- **Cross-package tests resolve deps via built `dist/`.** After editing a package's `src`, run `bun run build` before running any test in a *different* package that imports it. (`packages/executor`'s own tests import from its `src` directly, so Task 1/2 tests see edits without a rebuild; Task 3/4 in `packages/cli` import `@stackbase/executor`/`@stackbase/codegen` via `dist`, so they need a rebuild first.)
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

## File Structure

- `packages/executor/src/functions.ts` — MODIFY. Add `argsValidator`/`argsJson` to `RegisteredFunction`; add the typed `{ args, handler }` overload to `query`/`mutation`/`action`, building `v.object(args)`.
- `packages/executor/test/functions-args.test.ts` — CREATE. Surface + inference tests (Task 1).
- `packages/executor/src/executor.ts` — MODIFY. Import `ArgumentValidationError` + `validate`; add the `run()` enforcement guard.
- `packages/executor/test/executor-args.test.ts` — CREATE. Enforcement matrix (Task 2).
- `packages/cli/src/project.ts` — MODIFY. Populate `argsType` in the manifest entry.
- `packages/cli/test/codegen-argstype.test.ts` — CREATE. `argsType` wiring test (Task 3).
- `packages/cli/test/arg-validation-e2e.test.ts` — CREATE. Real-server round-trip (Task 4).
- `docs/enduser/functions.md` (or the nearest existing functions/validation doc) — MODIFY. Add an `args` example (Task 5).

---

### Task 1: `RegisteredFunction` fields + `functions.ts` typed `{ args, handler }` surface

**Files:**
- Modify: `packages/executor/src/functions.ts`
- Test: `packages/executor/test/functions-args.test.ts` (create)

**Interfaces:**
- Consumes: from `@stackbase/values` — `v` (has `v.object(fields)`), types `PropertyValidators`, `AnyValidator`, `ValidatorJSON`, `ObjectType`. From `./guest` — `MutationCtx`, `QueryCtx` (already imported).
- Produces: `RegisteredFunction` now has optional `argsValidator?: AnyValidator` and `argsJson?: ValidatorJSON`. `query`/`mutation`/`action` accept a new typed `{ args, handler }` def form in addition to the existing `{ handler }` / bare-function forms.

- [ ] **Step 1: Write the failing test**

Create `packages/executor/test/functions-args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { v } from "@stackbase/values";
import { mutation, query, action } from "../src/functions";

describe("functions.ts — args validator surface", () => {
  it("a def with `args` carries a live argsValidator and its JSON", () => {
    const fn = mutation({
      args: { name: v.string(), age: v.number() },
      handler: (_ctx, args) => `${args.name}:${args.age}`,
    });
    expect(fn.type).toBe("mutation");
    expect(fn.argsValidator).toBeDefined();
    expect(fn.argsJson).toBeDefined();
    // The JSON round-trips as an object validator over the declared fields.
    expect(fn.argsJson).toMatchObject({ type: "object" });
    expect(Object.keys((fn.argsJson as { value: Record<string, unknown> }).value)).toEqual(["name", "age"]);
  });

  it("the bare-function form carries no validator", () => {
    const fn = query((_ctx, _args) => 1);
    expect(fn.type).toBe("query");
    expect(fn.argsValidator).toBeUndefined();
    expect(fn.argsJson).toBeUndefined();
  });

  it("the `{ handler }`-only form carries no validator", () => {
    const fn = action({ handler: async () => "ok" });
    expect(fn.type).toBe("action");
    expect(fn.argsValidator).toBeUndefined();
    expect(fn.argsJson).toBeUndefined();
  });

  it("infers the handler args param from the validator (compile-time)", () => {
    mutation({
      args: { flag: v.boolean() },
      handler: (_ctx, args) => {
        const b: boolean = args.flag; // typed as boolean via ObjectType inference
        // @ts-expect-error — `missing` is not a declared arg
        args.missing;
        return b;
      },
    });
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/functions-args.test.ts`
Expected: FAIL — `argsValidator`/`argsJson` are undefined properties (the typed overload does not exist yet; the `@ts-expect-error` line may also report an *unused* directive, which still fails the run).

- [ ] **Step 3: Write minimal implementation**

Edit `packages/executor/src/functions.ts`. Replace the imports and the `RegisteredFunction` interface, and add the typed overloads to each factory. Full new file content for the top + the three factories:

```ts
/**
 * Function definitions — the Convex-compatible authoring surface. `query`/`mutation`/`action`
 * tag a handler with its UDF type; the executor sets up the right context and profile. An
 * optional `args` validator (a `PropertyValidators` record of `v.*`) is stored on the returned
 * function so the executor can validate incoming call args and codegen can type the client api.
 */
import type { UdfType } from "./profile";
import type { MutationCtx, QueryCtx } from "./guest";
import { v, type PropertyValidators, type AnyValidator, type ValidatorJSON, type ObjectType } from "@stackbase/values";

export interface RegisteredFunction {
  type: UdfType;
  handler: (ctx: unknown, args: unknown) => unknown | Promise<unknown>;
  /** Live validator for the call args (`v.object(args)`), when the function declares `args`. */
  argsValidator?: AnyValidator;
  /** `argsValidator.toJSON()`, for codegen to emit the typed `FunctionReference`. */
  argsJson?: ValidatorJSON;
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
  return rf;
}

type QueryDef<Args, Output> =
  | { handler: (ctx: QueryCtx, args: Args) => Output | Promise<Output> }
  | ((ctx: QueryCtx, args: Args) => Output | Promise<Output>);

export function query<A extends PropertyValidators, Output = unknown>(
  def: { args: A; handler: (ctx: QueryCtx, args: ObjectType<A>) => Output | Promise<Output> },
): RegisteredFunction;
export function query<Args = unknown, Output = unknown>(def: QueryDef<Args, Output>): RegisteredFunction;
export function query(def: unknown): RegisteredFunction {
  return build("query", def);
}

type MutationDef<Args, Output> =
  | { handler: (ctx: MutationCtx, args: Args) => Output | Promise<Output> }
  | ((ctx: MutationCtx, args: Args) => Output | Promise<Output>);

export function mutation<A extends PropertyValidators, Output = unknown>(
  def: { args: A; handler: (ctx: MutationCtx, args: ObjectType<A>) => Output | Promise<Output> },
): RegisteredFunction;
export function mutation<Args = unknown, Output = unknown>(def: MutationDef<Args, Output>): RegisteredFunction;
export function mutation(def: unknown): RegisteredFunction {
  return build("mutation", def);
}

type ActionDef<Args, Output> =
  | { handler: (ctx: unknown, args: Args) => Output | Promise<Output> }
  | ((ctx: unknown, args: Args) => Output | Promise<Output>);

export function action<A extends PropertyValidators, Output = unknown>(
  def: { args: A; handler: (ctx: unknown, args: ObjectType<A>) => Output | Promise<Output> },
): RegisteredFunction;
export function action<Args = unknown, Output = unknown>(def: ActionDef<Args, Output>): RegisteredFunction;
export function action(def: unknown): RegisteredFunction {
  return build("action", def);
}
```

Leave the existing `httpAction` factory (below this in the file) exactly as-is — it takes no `args`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/functions-args.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck the package**

Run: `cd /Volumes/Projects/concave-dev && bun run typecheck --filter @stackbase/executor`
Expected: PASS — the overloads resolve for all three call forms (typed `{args,handler}`, `{handler}`, bare fn).

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/executor/src/functions.ts packages/executor/test/functions-args.test.ts
git commit -m "feat(executor): args validator surface on query/mutation/action

Optional { args, handler } form builds a v.object(args) validator, stored on
RegisteredFunction as argsValidator (live) + argsJson (for codegen). Handler
args param is inferred via ObjectType<A>. httpAction unchanged; opt-in.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Executor `run()` enforcement guard

**Files:**
- Modify: `packages/executor/src/executor.ts`
- Test: `packages/executor/test/executor-args.test.ts` (create)

**Interfaces:**
- Consumes: `RegisteredFunction.argsValidator` (Task 1). From `@stackbase/values` — `validate(validator, value): ValidationFailure[]` (already-imported `Value` type). From `@stackbase/errors` — `ArgumentValidationError`.
- Produces: `InlineUdfExecutor.run()` throws `ArgumentValidationError` when incoming args fail the function's `argsValidator`, before any handler runs.

Note the test harness: `packages/executor/test/executor.test.ts` shows how to construct an `InlineUdfExecutor` and call `run()`. Read it first and reuse its setup (docstore, transactor, catalog, `run(fn, args, options)`). Do not invent a new harness.

- [ ] **Step 1: Write the failing test**

Create `packages/executor/test/executor-args.test.ts`. Model the executor/transactor/catalog setup on `packages/executor/test/executor.test.ts` (import the same helpers it uses). The behavioral core:

```ts
import { describe, it, expect } from "vitest";
import { v } from "@stackbase/values";
import { ArgumentValidationError } from "@stackbase/errors";
import { mutation, action } from "../src/functions";
// + the same executor/transactor/catalog/docstore setup imports executor.test.ts uses.

// Build an executor exactly as executor.test.ts does; expose a helper:
//   async function run(fn, args) { return executor.run(fn, args, { path: "app:fn" }); }

describe("executor — argument validation", () => {
  const echo = mutation({ args: { n: v.number() }, handler: (_ctx, args) => args.n });

  it("accepts well-typed args and runs the handler", async () => {
    const res = await run(echo, { n: 5 });
    expect(res.value).toBe(5);
  });

  it("rejects a wrong-typed arg with ArgumentValidationError", async () => {
    await expect(run(echo, { n: "not-a-number" })).rejects.toBeInstanceOf(ArgumentValidationError);
    await expect(run(echo, { n: "not-a-number" })).rejects.toThrow(/do not match validator/);
  });

  it("rejects a missing required arg", async () => {
    await expect(run(echo, {})).rejects.toBeInstanceOf(ArgumentValidationError);
  });

  it("rejects an extra (undeclared) arg (strict object)", async () => {
    await expect(run(echo, { n: 1, extra: true })).rejects.toBeInstanceOf(ArgumentValidationError);
  });

  it("accepts arbitrary args when the function declares no validator", async () => {
    const loose = mutation((_ctx, args) => args);
    const res = await run(loose, { anything: [1, 2, 3], nested: { ok: true } });
    expect(res.value).toEqual({ anything: [1, 2, 3], nested: { ok: true } });
  });

  it("validates an action's args too (guard runs before the action dispatch)", async () => {
    const act = action({ args: { x: v.string() }, handler: async (_ctx, args) => args.x });
    await expect(run(act, { x: 123 })).rejects.toBeInstanceOf(ArgumentValidationError);
  });
});
```

If `executor.test.ts`'s setup does not already support running an `action` (actions need an `invoke` runner), either provide a no-op `invoke` in the setup or drop the action assertion to a construction-only check — but prefer wiring `invoke` so the action guard is genuinely exercised. The action guard is proven end-to-end regardless in Task 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/executor-args.test.ts`
Expected: FAIL — no validation happens yet; the wrong-typed/missing/extra calls resolve instead of rejecting.

- [ ] **Step 3: Write minimal implementation**

Edit `packages/executor/src/executor.ts`:

1. Extend the `@stackbase/values` import (line ~13) to include `validate`:
   ```ts
   import { convexToJson, jsonToConvex, validate, type JSONValue, type Value } from "@stackbase/values";
   ```
2. Add an errors import near the other package imports (after line ~21):
   ```ts
   import { ArgumentValidationError } from "@stackbase/errors";
   ```
3. At the very top of `run()` — BEFORE the `httpAction`/`action` early-dispatch lines (`if (fn.type === "httpAction") …` / `if (fn.type === "action") …`) — insert the guard:
   ```ts
   async run<T = unknown>(fn: RegisteredFunction, args: unknown, options: RunOptions = {}): Promise<UdfResult<T>> {
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
     if (fn.type === "action") return this.runActionFn<T>(fn, args, options);
     // …rest of run() unchanged…
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/executor-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full executor suite (no regressions)**

Run: `cd packages/executor && ../../node_modules/.bin/vitest run`
Expected: PASS — every existing executor test still green (all existing functions omit `args`, so the guard is inert for them).

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/executor/src/executor.ts packages/executor/test/executor-args.test.ts
git commit -m "feat(executor): enforce args validator in run(), ArgumentValidationError

A function that declares args now has its incoming call args validated at the
top of run() — before any transaction setup or handler dispatch, above the
httpAction/action early-return so actions are validated too. Wrong-typed,
missing-required, and extra-key args are rejected. Absent validator = no-op.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Codegen `argsType` from the args validator

**Files:**
- Modify: `packages/cli/src/project.ts` (the manifest-building loop, ~line 88)
- Test: `packages/cli/test/codegen-argstype.test.ts` (create)

**Interfaces:**
- Consumes: `RegisteredFunction.argsJson` (Task 1). From `@stackbase/codegen` — `validatorToTsType(json: ValidatorJSON): string` (exported). The manifest entry type `AnalyzedFunction` already has an optional `argsType?: string` field (`packages/codegen/src/generate.ts`), consumed by `generateApi` to emit `FunctionReference<type, vis, argsType ?? "any", returnsType ?? "any">`.
- Produces: `loadProject(...).manifest` entries carry `argsType` (a TS type string) for functions that declare `args`, and `undefined` for those that don't.

- [ ] **Step 1: Rebuild dependency packages (cli tests resolve deps via dist)**

Run: `cd /Volumes/Projects/concave-dev && bun run build --filter @stackbase/executor --filter @stackbase/codegen`
Expected: build success — so the cli test sees Task 1's `argsJson` and codegen's `validatorToTsType` from `dist`.

- [ ] **Step 2: Write the failing test**

Create `packages/cli/test/codegen-argstype.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { generateApi } from "@stackbase/codegen";
import { loadProject } from "../src/index";

describe("codegen — argsType derived from the args validator", () => {
  const schema = defineSchema({ items: defineTable({ n: v.number() }) });
  const appModule = {
    add: mutation({ args: { name: v.string(), count: v.number() }, handler: (_ctx, a) => `${a.name}:${a.count}` }),
    ping: query((_ctx) => "pong"), // no args
  };

  it("populates the manifest entry's argsType for a function with args", () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const mod = project.manifest.find((m) => m.path === "app");
    const add = mod?.functions.find((f) => f.name === "add");
    const ping = mod?.functions.find((f) => f.name === "ping");
    expect(add?.argsType).toBeDefined();
    expect(add?.argsType).toContain("name");
    expect(add?.argsType).toContain("string");
    expect(add?.argsType).toContain("count");
    expect(ping?.argsType).toBeUndefined(); // no args -> stays any downstream
  });

  it("emits the derived args type into the generated api.d.ts", () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const api = generateApi(project.manifest);
    // The `add` FunctionReference carries the object type; `ping` falls back to `any`.
    expect(api.content).toMatch(/add:\s*FunctionReference<"mutation",\s*"public",\s*\{[^}]*name[^}]*\}/);
    expect(api.content).toMatch(/ping:\s*FunctionReference<"query",\s*"public",\s*any/);
  });
});
```

If `generateApi`'s exact output format differs (whitespace/quotes), adjust the regexes to the real emitted text — but keep both assertions: `add` carries the object type, `ping` falls back to `any`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/codegen-argstype.test.ts`
Expected: FAIL — `add.argsType` is `undefined` and the emitted `add` reference is `...,"public", any, ...`, because `project.ts` never populates `argsType`.

- [ ] **Step 4: Write minimal implementation**

Edit `packages/cli/src/project.ts`:

1. Add the import (with the other `@stackbase/codegen` imports near the top):
   ```ts
   import { validatorToTsType } from "@stackbase/codegen";
   ```
   (If `@stackbase/codegen` is already imported for types, add `validatorToTsType` to that import instead of a second statement.)
2. In the manifest-building loop, replace the `functions.push({ name, type: value.type, visibility: "public" });` line with:
   ```ts
   functions.push({
     name,
     type: value.type,
     visibility: "public",
     argsType: value.argsJson ? validatorToTsType(value.argsJson) : undefined,
   });
   ```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/codegen-argstype.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/src/project.ts packages/cli/test/codegen-argstype.test.ts
git commit -m "feat(codegen): derive FunctionReference argsType from the args validator

loadProject now emits argsType (via validatorToTsType over argsJson) into each
manifest entry, so the generated api.d.ts types client calls against the
declared args. Functions without args stay `any` — unchanged DX.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end through the real `stackbase dev` server

**Files:**
- Create: `packages/cli/test/arg-validation-e2e.test.ts`

**Interfaces:**
- Consumes: the full stack (`loadProject`, `createEmbeddedRuntime`, `startDevServer`) and the `POST /api/run` HTTP path, which maps any `StackbaseError` to `{ error, code }` with `getHttpStatus` (`packages/cli/src/http-handler.ts`) — so `ArgumentValidationError` surfaces as HTTP 400 with `code: "ARGUMENT_VALIDATION"`.
- Produces: proof that a wrong-typed client arg is rejected end-to-end, and a well-typed one commits.

This mirrors `packages/cli/test/validation-e2e.test.ts` (document validation E2E) — read it and reuse its shape.

- [ ] **Step 1: Rebuild dependency packages**

Run: `cd /Volumes/Projects/concave-dev && bun run build --filter @stackbase/executor`
Expected: build success — the cli E2E resolves `@stackbase/executor` (with Task 1/2 changes) via `dist`.

- [ ] **Step 2: Write the failing test**

Create `packages/cli/test/arg-validation-e2e.test.ts`:

```ts
/**
 * End-to-end: function ARGUMENT validation, enforced through the REAL dev server.
 *
 * Argument validation (a call whose args don't match the function's `args` validator throws
 * ArgumentValidationError) is enforced in the executor and proven there by unit tests. This
 * proves the WHOLE path works through the shipped `stackbase dev` server (real startDevServer +
 * loadProject, real HTTP), the "test through the shipped entrypoint" rule:
 *
 *   POST /api/run with well-typed args -> commits, read-back shows the row.
 *   POST /api/run with a wrong-typed arg -> 400 with an ARGUMENT_VALIDATION code, and the row is
 *     NOT persisted — the transaction never ran.
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, startDevServer } from "../src/index";

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });

const appModule = {
  add: mutation({
    args: { body: v.string() },
    handler: (ctx: any, { body }: { body: string }) => (ctx.db as any).insert("notes", { body }), // eslint-disable-line @typescript-eslint/no-explicit-any
  }),
  list: query<Record<string, never>, string[]>({
    handler: async (ctx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      (await (ctx.db.query("notes", "by_creation") as any).collect()).map((d: { body: string }) => d.body),
  }),
};

describe("argument validation — end-to-end through the real dev server", () => {
  it("commits a well-typed call and rejects a wrong-typed one with ARGUMENT_VALIDATION", async () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });

    try {
      // 1. Well-typed args commit.
      const ok = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:add", args: { body: "hello" } }),
      });
      expect(ok.status).toBe(200);

      const afterOk = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:list", args: {} }),
      });
      expect(((await afterOk.json()) as { value: string[] }).value).toEqual(["hello"]);

      // 2. Wrong-typed arg is rejected with ARGUMENT_VALIDATION; nothing persisted.
      const bad = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:add", args: { body: 123 } }),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error: string; code: string };
      expect(badBody.code).toBe("ARGUMENT_VALIDATION");
      expect(badBody.error).toMatch(/do not match validator/);

      const afterBad = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:list", args: {} }),
      });
      // Still exactly the one valid row — the rejected call never ran.
      expect(((await afterBad.json()) as { value: string[] }).value).toEqual(["hello"]);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails (before deps are built) or passes (after)**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/arg-validation-e2e.test.ts`
Expected: PASS if Step 1's rebuild picked up Tasks 1–2 (the executor guard is live in `dist`). If it FAILS with the wrong-typed call returning 200, the `@stackbase/executor` dist is stale — re-run Step 1's build and retry. (This test has no separate "red" state of its own; its red state is Tasks 1–2 being absent.)

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/test/arg-validation-e2e.test.ts
git commit -m "test(cli): E2E arg validation through the real dev server

Proves a wrong-typed arg to a mutation declaring args is rejected end-to-end
(400, ARGUMENT_VALIDATION, not persisted) and a well-typed call commits.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Backward-compat audit + end-user docs

**Files:**
- Read-only audit across `packages/`, `components/`, `examples/`
- Modify: `docs/enduser/functions.md` (or the nearest existing functions/validation end-user doc; if none exists, create `docs/enduser/validation.md`)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: a confirmed-empty audit (no existing function opts into `args`, so nothing changes behavior) and a documented `args` example for end users.

- [ ] **Step 1: Audit existing function definitions for any `args` usage**

Run:
```bash
cd /Volumes/Projects/concave-dev
grep -rnE "\b(mutation|query|action)\s*\(\s*\{" packages components examples --include=*.ts | grep -v test | grep -v node_modules | grep -v /dist/
grep -rnE "args:\s*\{" packages components examples --include=*.ts | grep -vE "test|node_modules|/dist/|scheduler|scheduler|workflow" | head -40
```
Expected: no production function passes `args:` to `mutation`/`query`/`action` today (the arg surface was unused before this slice). Record the finding. If any function DOES already pass an `args:` key to these factories (it would previously have been ignored), verify its args conform to the validator now that it is enforced; if not, that is a real behavior change — surface it rather than silently "fixing" it.

- [ ] **Step 2: Full monorepo build + typecheck + test**

Run:
```bash
cd /Volumes/Projects/concave-dev
bun run build && bun run typecheck && bun run test
```
Expected: all green. If any pre-existing test breaks, it is either (a) a function that already passed `args` and now fails validation — a real finding to surface — or (b) a regression to fix.

- [ ] **Step 3: Write the end-user doc example**

Add to `docs/enduser/functions.md` (under the function-definition section; create `docs/enduser/validation.md` if there is no functions doc). Content:

```markdown
## Validating function arguments

Declare an `args` validator to check a function's arguments at runtime and get a
fully-typed handler and client API. Arguments are validated before your handler runs;
a mismatch is rejected with an `ARGUMENT_VALIDATION` error (HTTP 400) and the handler
never executes.

```ts
import { mutation } from "./_generated/server";
import { v } from "@stackbase/values";

export const send = mutation({
  args: { conversationId: v.id("conversations"), body: v.string() },
  handler: async (ctx, args) => {
    // args.conversationId and args.body are typed from the validator.
    return ctx.db.insert("messages", { conversationId: args.conversationId, body: args.body });
  },
});
```

Validation is **opt-in**: a function with no `args` accepts any arguments (unchanged
behavior). The validator is strict — extra, missing-required, or wrong-typed arguments
are all rejected. Use `v.optional(...)` for arguments that may be omitted. `httpAction`
takes a raw `Request` and has no `args` validator.
```

(Match the surrounding doc's `import` convention — end-user code imports `mutation` from `./_generated/server` and `v` from `@stackbase/values`; adjust if the existing docs import `v` differently.)

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add docs/enduser/
git commit -m "docs(enduser): document opt-in function argument validation

Adds an args-validator example and states the opt-in + strict semantics.
Backward-compat audit: no existing function opted into args, so enforcement is
inert for all current code.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Goal 1 (authoring surface, opt-in) → Task 1. ✅
- Goal 2 (runtime enforcement, `ArgumentValidationError`) → Task 2. ✅
- Goal 3 (handler-side inference via `ObjectType`) → Task 1 (the `@ts-expect-error` inference test). ✅
- Goal 4 (codegen typed api) → Task 3. ✅
- Enforcement site "top of `run()`, above the action dispatch" → Task 2 Step 3 + the action assertion. ✅
- E2E through the shipped entrypoint → Task 4. ✅
- Backward-compat empty audit + docs → Task 5. ✅
- Non-goals (returns, httpAction args, coercion) → held out in Global Constraints; no task adds them. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above" — every code step carries real code. The two "adjust the regex/import if the real output differs" notes (Tasks 3, 5) are precision hedges around exact emitted whitespace and doc conventions, not missing logic. ✅

**3. Type consistency:** `argsValidator: AnyValidator` and `argsJson: ValidatorJSON` are defined in Task 1 and consumed by the same names in Tasks 2 (`fn.argsValidator`) and 3 (`value.argsJson`). `validate(validator, value): ValidationFailure[]` with `.path`/`.message` matches `@stackbase/values`. `ArgumentValidationError` message uses `do not match validator`, asserted verbatim in Tasks 2 and 4. `validatorToTsType` and `generateApi` are used with their real `@stackbase/codegen` signatures. ✅
