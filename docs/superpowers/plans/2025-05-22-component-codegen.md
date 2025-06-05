# Component Codegen — Typed `ctx.auth` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ctx.auth.getUserId()` fully typed in app functions — no `(ctx as any).auth` cast. Codegen emits a `declare module` augmentation of the executor's `QueryCtx`/`MutationCtx` for each enabled component that declares a context type.

**Architecture:** `QueryCtx`/`MutationCtx` are `interface`s (augmentable). A component declares `contextType: { import, type }` (the auth package exports `AuthContext` and points at it). Codegen (`generateServer`) emits, into the generated `server.ts`, `declare module "@stackbase/executor" { interface QueryCtx { auth: import("@stackbase/auth").AuthContext } interface MutationCtx { ... } }` for each enabled component. App functions importing `query`/`mutation` from `./_generated/server` then see `ctx.auth` typed — generated only when the component is in the project's `stackbase.config.ts`.

**Tech Stack:** TypeScript, pnpm/turbo, vitest. Touches `@stackbase/component` (`ComponentDefinition.contextType`), `@stackbase/auth` (export `AuthContext` + declare it), `@stackbase/codegen` (emit the augmentation), `@stackbase/cli` (thread the contextType info into codegen), `examples/auth-demo` (drop the cast, verify typed).

## Global Constraints

- The augmentation is emitted ONLY for enabled components (those in the project's config) that declare a `contextType`. A project without auth → no augmentation → `ctx.auth` is a type error (correct — it isn't enabled).
- `ctx.<name>` is typed as REQUIRED (not optional) — at runtime every function gets every enabled component's facade (C3.5a eager-attach), so the type matches reality and the DX avoids `?.`.
- `@stackbase/codegen` must NOT gain a dependency on `@stackbase/component` — pass codegen a lightweight `Array<{ name; contextType? }>`, not full `ComponentDefinition`s.
- Strict TS; ESM. The augmentation's `import("@stackbase/auth")` resolves in the app project (it depends on `@stackbase/auth`).

---

### Task 1: `ComponentDefinition.contextType` + auth exports & declares `AuthContext`

**Files:**
- Modify: `packages/component/src/define-component.ts` (`ComponentDefinition.contextType`)
- Modify: `components/auth/src/context.ts` (export `AuthContext`, annotate `authContext`)
- Modify: `components/auth/src/component.ts` (set `contextType`)
- Modify: `components/auth/src/index.ts` (export `AuthContext`)
- Test: `components/auth/test/context-type.test.ts`

**Interfaces:**
- Produces: `ComponentDefinition.contextType?: { import: string; type: string }`; `@stackbase/auth` exports `interface AuthContext { getUserId(): Promise<string | null> }`; the `auth` component sets `contextType: { import: "@stackbase/auth", type: "AuthContext" }`.

- [ ] **Step 1: Write the failing test**
```ts
// components/auth/test/context-type.test.ts
import { describe, it, expect } from "vitest";
import { auth } from "../src/component";

describe("auth contextType (for codegen)", () => {
  it("declares its ctx contribution type", () => {
    expect(auth.contextType).toEqual({ import: "@stackbase/auth", type: "AuthContext" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/auth test context-type` → FAIL (`contextType` undefined).

- [ ] **Step 3: Write minimal implementation**

In `packages/component/src/define-component.ts`, add to `ComponentDefinition`:
```ts
  /** The TS type this component contributes to ctx, for codegen: ctx[name]: import(import).type. */
  contextType?: { import: string; type: string };
```

In `components/auth/src/context.ts`, export the type and annotate the builder:
```ts
export interface AuthContext {
  getUserId(): Promise<string | null>;
}
export function authContext(cctx: ComponentContext): AuthContext {
  return {
    getUserId: async (): Promise<string | null> => { /* unchanged body */ },
  };
}
```
(Keep the existing body. The annotation just pins the return type to `AuthContext`.)

In `components/auth/src/component.ts`, add `contextType` to the `defineComponent` call:
```ts
  contextType: { import: "@stackbase/auth", type: "AuthContext" },
```
In `components/auth/src/index.ts`, export the type: `export type { AuthContext } from "./context";`.

- [ ] **Step 4: Run test, typecheck, commit** — `pnpm --filter @stackbase/auth test` → all pass · `pnpm --filter @stackbase/auth exec tsc --noEmit` → clean · `pnpm --filter @stackbase/component exec tsc --noEmit` → clean.
```bash
git add packages/component/src/define-component.ts components/auth/src
git commit -m "feat(auth): export AuthContext + declare contextType for codegen"
```

---

### Task 2: Codegen emits the `ctx` augmentation

**Files:**
- Modify: `packages/codegen/src/generate.ts` (`CodegenInput` + `generateServer` emit the augmentation)
- Test: `packages/codegen/test/ctx-augmentation.test.ts` (or extend the existing generate test)

**Interfaces:**
- Consumes: a lightweight component descriptor.
- Produces: `CodegenInput` gains `components?: Array<{ name: string; contextType?: { import: string; type: string } }>`; `generateServer` emits a `declare module "@stackbase/executor"` block augmenting `QueryCtx`/`MutationCtx` with `[name]: import("<import>").<type>` for each component that has a `contextType`. `generateAll` threads `components` to `generateServer`.

- [ ] **Step 1: Write the failing test**
```ts
// packages/codegen/test/ctx-augmentation.test.ts
import { describe, it, expect } from "vitest";
import { generateServer } from "../src/generate";

const emptySchema = { tables: {} } as never;

describe("generateServer — ctx augmentation", () => {
  it("emits a typed ctx.<component> augmentation for components with a contextType", () => {
    const out = generateServer(emptySchema, { components: [{ name: "auth", contextType: { import: "@stackbase/auth", type: "AuthContext" } }] });
    expect(out.content).toContain('declare module "@stackbase/executor"');
    expect(out.content).toContain('auth: import("@stackbase/auth").AuthContext');
    expect(out.content).toContain("interface QueryCtx");
    expect(out.content).toContain("interface MutationCtx");
  });
  it("emits no augmentation when there are no components with a contextType", () => {
    const out = generateServer(emptySchema, {});
    expect(out.content).not.toContain("declare module");
  });
});
```
(Match `generateServer`'s real signature — read `generate.ts`; it currently is `generateServer(_schema, options)`. The components live on `options` (CodegenOptions) OR add a param — pick whichever fits the existing shape and adjust the test. The binding assertion: the augmentation appears for a component with `contextType`, absent otherwise.)

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/codegen test ctx-augmentation` → FAIL.

- [ ] **Step 3: Write minimal implementation**

Add the component descriptor to `CodegenInput` (and/or `CodegenOptions`, matching how `generateServer` receives data):
```ts
interface ComponentTypeInfo { name: string; contextType?: { import: string; type: string } }
// CodegenInput gains:  components?: ComponentTypeInfo[]
```
In `generateServer`, after the existing re-exports, append the augmentation when any component has a `contextType`:
```ts
  const ctxComponents = (components ?? []).filter((c) => c.contextType);
  let augmentation = "";
  if (ctxComponents.length > 0) {
    const fields = ctxComponents
      .map((c) => `    ${c.name}: import("${c.contextType!.import}").${c.contextType!.type};`)
      .join("\n");
    augmentation = `
// Component context contributions (ctx.<component>), typed.
declare module "@stackbase/executor" {
  interface QueryCtx {
${fields}
  }
  interface MutationCtx {
${fields}
  }
}
`;
  }
  // content = existing re-exports + augmentation
```
Thread `components` from `generateAll(input)` into `generateServer`.

- [ ] **Step 4: Run test, typecheck, commit** — `pnpm --filter @stackbase/codegen test` → all pass · `pnpm --filter @stackbase/codegen exec tsc --noEmit` → clean.
```bash
git add packages/codegen/src/generate.ts packages/codegen/test/ctx-augmentation.test.ts
git commit -m "feat(codegen): emit typed ctx.<component> augmentation from enabled components"
```

---

### Task 3: Thread components into codegen + the auth-demo uses typed `ctx.auth`

**Files:**
- Modify: `packages/cli/src/push-pipeline.ts` (pass component contextType info to `generateAll`)
- Modify: `examples/auth-demo/convex/whoami.ts` (import from `_generated/server`, drop the cast)
- Regenerate: `examples/auth-demo/convex/_generated/*`
- Test: a codegen-integration assertion (the auth-demo's generated server contains the augmentation) + the example typechecks with no cast.

**Interfaces:**
- Consumes: `CodegenInput.components` (Task 2), `ComponentDefinition.contextType` (Task 1), `push`'s `components` param (config-loader).
- Produces: `push(loaded, components)` passes `components.map(c => ({ name: c.name, contextType: c.contextType }))` to `generateAll`; `whoami.ts` uses `ctx.auth.getUserId()` with no cast.

- [ ] **Step 1: Write the failing check** — assert the auth-demo's generated server includes the augmentation after codegen, AND `whoami.ts` (without the cast) typechecks. The simplest reliable form: a test in `packages/cli/test/` that runs `push(loaded, [authLike])` (an inline component with a `contextType`) over a minimal `LoadedProject` and asserts `generated.files` (or the server file) contains `declare module "@stackbase/executor"` + `auth: import("@stackbase/auth").AuthContext`. (The end-to-end example typecheck is verified in Step 4.)

- [ ] **Step 2: Run it, confirm it fails** — the generated server has no augmentation (push doesn't pass components to codegen yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/push-pipeline.ts`, pass the component context info to `generateAll`:
```ts
const generated = generateAll({
  schema: project.schemaJson,
  manifest: project.manifest,
  components: components.map((c) => ({ name: c.name, contextType: c.contextType })),
});
```
(`components` is the `push(loaded, components)` param from the config-loader; if it's defaulted `[]`, the map is empty and no augmentation is emitted — unchanged behavior.)

Regenerate the auth-demo's `_generated` (run `pnpm --filter @stackbase/cli build` then the example's codegen path, e.g. `bun ../../packages/cli/dist/bin.js dev` briefly, or a `codegen` command if present — produce the updated `_generated/server.ts` with the augmentation).

In `examples/auth-demo/convex/whoami.ts`:
```ts
import { query } from "./_generated/server";
export const get = query(async (ctx) => ctx.auth.getUserId());
```
(No `as unknown as ...` cast — `ctx.auth` is now typed via the generated augmentation.)

- [ ] **Step 4: Run test, full workspace, commit**

- `pnpm --filter @stackbase/cli test` → the augmentation check passes.
- `pnpm --filter @stackbase/example-auth-demo exec tsc --noEmit` → **clean with `ctx.auth.getUserId()` and NO cast** (this is the proof — if `ctx.auth` weren't typed, this would error).
- `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.
```bash
git add packages/cli/src/push-pipeline.ts examples/auth-demo/convex
git commit -m "feat(cli,example): thread components into codegen; auth-demo uses typed ctx.auth (no cast)"
```

---

## Self-Review

**Spec coverage (the typed-`ctx.auth` DX gap from the config-loader slice):**
- A component declares its context type — Task 1 (`ComponentDefinition.contextType`, auth's `AuthContext`). ✅
- Codegen emits the typed `ctx.<component>` augmentation for enabled components — Task 2. ✅
- The auth-demo gets typed `ctx.auth.getUserId()` with no cast — Task 3 (proven by the example's `tsc --noEmit`). ✅
- **Out of scope (follow-on):** typed `api.auth.*` (the client calling component functions with precise arg/return types — needs component function signatures in the manifest); `ctx.<component>` for non-auth components (the mechanism is general — any component with a `contextType` works, but only auth has one today).

**Placeholder scan:** none — runnable code/commands. The Task 2 test note ("match generateServer's real signature") directs the implementer to read `generate.ts` and place `components` on the right param (CodegenInput vs CodegenOptions) — the binding assertion is concrete.

**Type consistency:** `ComponentDefinition.contextType` (Task 1) → read by `push` and mapped into `CodegenInput.components` (Task 3) → consumed by `generateServer` (Task 2) to emit `ctx[name]: import("<import>").<type>`. `AuthContext` (Task 1, auth) is the type the augmentation references and the type `authContext` returns — so the generated `ctx.auth` shape matches the runtime facade exactly. The augmentation augments the same `QueryCtx`/`MutationCtx` interfaces that `query`/`mutation` (re-exported from `_generated/server`) use.
