# `@stackbase/test` — In-Memory Function Test Harness + Conformance Suite — Design Spec

**Date:** 2025-08-12
**Status:** Approved (brainstorm) — pending implementation plan
**Slice:** Testing layer 1 (in-memory ergonomic harness) + clean-room Convex/concave-parity conformance suite

---

## 1. Goal

Ship `@stackbase/test` — an ergonomic, in-memory, real-engine function-test harness (`createTestStackbase`) — and a thorough clean-room conformance suite dogfooded on it. Two outcomes in one slice:

1. **Close a real DX parity gap.** Convex ships `convex-test`; concave documented `@concavejs/test`. Stackbase users currently *cannot* ergonomically unit-test their functions — they'd hand-compose `EmbeddedRuntime` the way our internal `makeRuntime` helpers do (~12 bespoke copies). Ergonomic function testing is table-stakes DX for a BaaS, and DX is this project's stated core value.
2. **Outside-in confidence the engine matches documented semantics.** Our 149 existing tests are inside-out (authored by us, testing what we thought of). A conformance suite written against the *documented contract* is the missing external oracle for a reimplementation that claims Convex compatibility.

## 2. Context: the 3-layer testing model

Concave's own docs describe three testing layers (fastest → most thorough). Mapping to our current reality:

| Layer | Concave | Stackbase status |
|---|---|---|
| **1. In-memory ergonomic harness** (real engine, fast) | `@concavejs/test` / `createTestConcave` | ❌ **Missing** — the gap this slice fills. Capability exists (`EmbeddedRuntime`), no public surface. |
| **2. E2E vs a booted server** | boot `createConcave` + HTTP client | ✅ Have it — 11 `packages/cli/test/*-e2e.test.ts`. |
| **3. Cross-runtime (Bun vs Node)** | parameterized runtime import | 🟡 Partial — `docstore-sqlite` bun test + `build-e2e` under Bun. Out of scope here. |

### Fidelity ranking (why our harness is *better* than `convex-test`)

- `convex-test`: reimplements the backend semantics in **JavaScript** — data in JS `Map`s, a **mock engine**. Its tests validate the mock, which can silently drift from the real server.
- `@concavejs/test`: the **real engine** + an in-memory (`docstore-memory`, JS `Map`) storage adapter.
- **`@stackbase/test` (this design): the real engine + real SQLite in `:memory:`** — the exact production `SqliteDocStore` code path, DB in RAM. Highest fidelity of the three; the whole class of "mock behaved differently than production" bugs cannot occur, and the harness doubles as a regression net over the real production code paths.

## 3. Scope decision

**Ambitious-but-realistic (the call for a best-in-class open-source reactive BaaS):** a thorough behavioral conformance suite (not a smoke test that merely re-proves existing coverage; not harness-first-defer-confidence that contradicts the goal), with **reactivity as a first-class harness capability**.

Rationale for reactivity in-harness: reactivity is *the* defining feature of this product and its highest-risk code — read-set/write-set intersection is, per `CLAUDE.md`, "the heart of the system." `convex-test` **structurally cannot test reactivity** (function-level mock). A best-in-class reactive BaaS must let users assert that their subscriptions invalidate correctly. Feasibility confirmed: `packages/sync` already isolates `SubscriptionManager` ("subscriptions whose read set intersects the given write ranges") from the websocket transport, and `EmbeddedRuntime` exposes the commit fan-out (`onCommit`) — so in-process reactivity testing needs no server.

## 4. Architecture

New package **`packages/test` → `@stackbase/test`**. No new engine code — it *generalizes* the bespoke `makeRuntime` helpers into one public surface. Dependencies (dependency-light):

- `@stackbase/runtime-embedded` — `EmbeddedRuntime` (the real engine).
- `@stackbase/docstore-sqlite` — `SqliteDocStore(new NodeSqliteAdapter())`, which defaults to `":memory:"` (`node-adapter.ts:46`).
- `@stackbase/component` — `composeComponents`.
- `@stackbase/sync` — `SubscriptionManager` (for `t.subscribe`).
- `@stackbase/client` — `getFunctionPath(ref | string)` + the `anyApi` Proxy (function-reference resolution, reused verbatim).
- `@stackbase/storage` — the always-on core storage modules/provider (so `ctx.storage` works in tests), wired the same way `packages/cli/src/boot.ts` does via `withStorageModules`.
- `@stackbase/executor`, `@stackbase/values` — types + `defineSchema`/validators.

### Composition without codegen

`createTestStackbase({ modules, components?, schema? })` turns live module exports into a running backend at runtime (no codegen step):

1. **Flatten `modules`.** `modules` maps `convex/`-relative paths to their exports, e.g. `{ "messages.ts": messages, "schema.ts": schema, "http.ts": http }`. Strip the `.ts`/`.js` extension → module path (`"messages.ts"` → `"messages"`). For each export that is a `RegisteredFunction` (query/mutation/action/httpAction), register it under `"<modpath>:<exportName>"` (e.g. `"messages:send"`). Vitest users may pass `import.meta.glob("../convex/**/*.ts")` (a map of path → async loader); the harness awaits loaders.
2. **Schema (`schema: "auto"` default).** If a `schema.ts` module with a `defineSchema` default export is present (or `schema` passed explicitly), use `schema.export()` as the `schemaJson` and enforce validation exactly like production. `"auto"` = enforce iff a schema is present; callers may force on/off.
3. **HTTP router.** An `http.ts` default export (`httpRouter()`) is passed to the runtime's route table (`setRoutes`) so `t.fetch` works.
4. **Components.** `components?: ComponentDefinition[]` (e.g. `[defineScheduler(), defineWorkflow({ workflows })]`) composed via `composeComponents({ schemaJson, moduleMap }, components, tableNumberOverrides?)`. Default: none (a plain app). This mirrors how `components/*/test/helpers.ts` compose today.
5. **Instantiate.** `EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), ...composed, systemModules, now? })`, then wire always-on storage (`withStorageModules`) as `boot.ts` does.

One fully-isolated `:memory:` backend per `createTestStackbase()` call.

## 5. API surface

```ts
export interface CreateTestOptions {
  modules: Record<string, unknown> | Record<string, () => Promise<unknown>>; // explicit or import.meta.glob
  components?: ComponentDefinition[];   // opt-in scheduler/workflow/etc; default none
  schema?: SchemaDefinition | "auto" | false; // default "auto"
  now?: () => number;                   // injectable virtual clock (default a fixed start ts)
}

export function createTestStackbase(opts: CreateTestOptions): TestStackbase;

export interface TestStackbase {
  query<T>(ref: FunctionReference | string, args?: Record<string, Value>): Promise<T>;
  mutation<T>(ref: FunctionReference | string, args?: Record<string, Value>): Promise<T>;
  action<T>(ref: FunctionReference | string, args?: Record<string, Value>): Promise<T>;

  // Direct ctx.db access for setup/asserts without defining a function (runs in a transaction).
  run<T>(fn: (ctx: MutationCtx) => Promise<T>): Promise<T>;

  // Same backend, ambient identity set on every call made through the returned view.
  withIdentity(identity: string): TestStackbase;

  // Route a standard Request through the app's http.ts router.
  fetch(request: Request): Promise<Response>;

  // Reactive subscription: re-runs the query when a committed write's range intersects its read set.
  subscribe<T>(ref: FunctionReference | string, args?: Record<string, Value>): TestSubscription<T>;

  // Deterministic scheduler control (virtual clock): drive due scheduled jobs to completion.
  finishScheduledFunctions(): Promise<void>;
  advanceTimers(ms: number): Promise<void>;

  close(): Promise<void>;
}

export interface TestSubscription<T> {
  value(): T;                     // latest computed result
  onChange(cb: (v: T) => void): () => void; // fires on re-run; returns an unsubscribe
  unsubscribe(): void;
}
```

### Behavior notes

- **Result unwrapping.** `query`/`mutation`/`action` unwrap `UdfResult` to the value; a function error becomes a natural promise rejection so `await expect(...).rejects.toThrow(...)` works (matches how `runtime.run` rejects today).
- **Reference resolution.** Every `ref` is passed through `@stackbase/client`'s `getFunctionPath`, so typed `api.*`/`internal.*` (the app's generated references) and `"module:fn"` strings both work identically. Internal functions are callable (tests need them), matching `convex-test`/`@concavejs/test`.
- **`t.run(fn)`.** Runs `fn` with a full db-writer `ctx` inside a transaction. Intended mechanism (no engine change): the harness registers a system module `_test:_run` backed by a mutable "current callback" slot; `t.run` sets the slot, invokes `_test:_run` through the trusted path, and clears it. (If a cleaner `EmbeddedRuntime.runInTransaction(fn)` seam proves warranted during implementation, that is an acceptable substitute — decided at plan time.)
- **`t.subscribe`.** Wires `SubscriptionManager` to the runtime's `onCommit` fan-out: on subscribe, run the query and register its read-set; on each commit, `SubscriptionManager` selects subscriptions whose read set intersects the write ranges, the harness re-runs those queries and fires `onChange`. No websocket/transport involved.
- **Scheduler/time.** The harness composes the scheduler (when `components` includes it) with the injected `now`. `finishScheduledFunctions()` advances the clock past due jobs and drives the scheduler driver's `__tick` seam until no jobs are due; `advanceTimers(ms)` advances the virtual clock and drives one pass.

## 6. Identity model & the honest divergence

Stackbase's engine identity is a **string token** (`cctx.identity: string | null`), resolved by the app's auth component — e.g. `components/auth`'s `ctx.auth` does a *session-table lookup* (`token → user id`). This differs from Convex/concave, where `ctx.auth.getUserIdentity()` returns a stateless **JWT-claims object** (`{ subject, email, ... }`) with no lookup.

**Decision:** `t.withIdentity(identity: string)` sets the raw ambient token — faithful to *our* model. "Run as user X" means using a token the app's sessions resolve to X (or, under `components/authz`, the subject string). We do **not** fake a Convex claims layer we don't have. This divergence is:
- **Documented plainly** in `docs/enduser/testing.md`.
- **Asserted explicitly** in the conformance suite's `identity` area (the suite's job is to surface divergences, not hide them).

This keeps the harness honest and avoids scope-creeping into an auth-model change.

## 7. Conformance suite

**Location.** `packages/test/test/conformance/*.test.ts` — dogfoods the harness (every `t.*` method is exercised) *and* is the engine's outside-in correctness net and the harness's own coverage.

**Authoring rule (licensing-critical).** Clean-room. We *study* the `convex-test` demos (`.reference/convex-backend/npm-packages/demos/convex-test/`) and concave's testing doc **only to enumerate which behaviors matter**, then author every test in our own words against our engine. We never copy, port, or mechanically adapt FSL-licensed test code (per `.reference/README.md`). Behaviors are facts; test code is not copied.

**Coverage areas** (each area = its own `*.test.ts`):

- `db-crud` — insert/get/patch/replace/delete; `.order("asc"|"desc")` stability; overwrite/partial-patch semantics.
- `index-reads` — `withIndex` half-open range bounds; equality + range composition; ordering within an index.
- `pagination` — cursor round-trips, `isDone`, `continueCursor`, empty/last-page, split-cursor semantics.
- `validators` — accept/reject per type; coercion corners (int64/float64/bytes, nested `v.optional`, unions, `v.id`).
- `ids` — id uniqueness; cross-table id rejection; `v.id("table")` shape validation.
- `reactivity` — **surgical invalidation precision**: a write whose range intersects a subscription's read set re-triggers it; a write that does *not* intersect must *not*; row-level vs range-level; delete/insert boundaries.
- `scheduler` — at-most-once delivery, cancel, retry/backoff, cron catch-up — driven by the virtual clock (`finishScheduledFunctions`/`advanceTimers`).
- `http-router` — method + exact/prefix precedence, reserved-path rejection, `t.fetch` round-trip through a webhook → mutation → reactive fan-out.
- `errors` — documented error shapes (validation error, not-found, uncaught-in-handler) surface consistently.
- `identity` — `t.withIdentity` sets the ambient token; the token/claims divergence is asserted as our documented behavior.

**Depth target:** thorough (~60–120 tests across areas) — the edge cases that actually bite a reimplementation, not a surface smoke.

## 8. Isolation, lifecycle, harness self-tests

- **Isolation.** One `:memory:` backend per `createTestStackbase()`. No shared state between instances. Create one per test for independence, or share within a `describe` for speed.
- **Lifecycle.** `t.close()` stops drivers (`stopDrivers`) and closes the docstore; always call it (a `try/finally` or per-test instance). Leaking a driver timer across tests must not happen.
- **Harness self-tests** (`packages/test/test/harness/*.test.ts`, distinct from conformance): two independent instances don't see each other's data; `close()` cleans up (no lingering timers); `schema:"auto"` enforces validation when a schema is present and skips when absent; string-path and `api.*`-proxy refs resolve to the same function; `withIdentity` view shares the backend but overrides identity.

## 9. Documentation

`docs/enduser/testing.md` — the public testing guide, completing the documented 3-layer model (layer 1 was the only gap). Adapted **clean-room** from concave's testing doc (which `docs/enduser/` is explicitly licensed to rebrand), covering: `createTestStackbase` usage, the `modules` map (explicit + `import.meta.glob`), function references (typed + string), `withIdentity` **with the honest token-vs-claims note**, `t.fetch`, **`t.subscribe` (reactivity testing — a capability concave's doc never had)**, scheduler/time control, isolation, and a CI snippet. Cross-links the existing layer-2 (E2E) story.

## 10. Licensing posture

- We build our own package; we **study** `convex-test`/`@concavejs/test`'s *documented API shape* and demo *behaviors* — the sanctioned "read to understand, capture in our own words" path (`docs/enduser/` is explicitly derived-from-concave-docs-rebranded).
- We **never** copy, vendor, or mechanically port FSL-licensed code (convex-test source, concave packages, or their test files) into `packages/`. Behaviors and interface *shapes* are facts; code is not copied. (Per `.reference/README.md`.)

## 11. Scope boundaries (YAGNI held)

- **SQLite `:memory:` only.** No JS-`Map` `docstore-memory` until a genuinely `node:sqlite`-free target (edge/workerd/browser test runner) demands it. Highest fidelity, zero new storage code.
- **No cross-runtime matrix** in this slice (layer 3 stays as-is).
- **Identity stays string-based** — no faked Convex claims layer, no auth-model change.
- **No visual/UI**, no new CLI command (this is a library + docs).
- **No optimistic-update client testing** — that belongs to a future client slice.

## 12. Success criteria

- `@stackbase/test` builds, typechecks, and passes its harness self-tests under Node/vitest (the suite's runtime).
- The conformance suite (~60–120 tests) is green against the real engine, covering all §7 areas including reactivity invalidation precision and scheduler determinism.
- `docs/enduser/testing.md` documents the full layer-1 surface accurately, including the honest identity divergence and the reactivity-testing capability.
- The top-level `bun run test` includes the new package; `bun run build`/`typecheck` stay green.
- A short usage example (a few functions + a test) demonstrably works, matching the documented API.

## 13. Decisions log (resolved this brainstorm)

1. **Depth:** thorough conformance (option b), not smoke, not defer. Reactivity is in-scope and first-class.
2. **Storage:** SQLite `:memory:` (highest fidelity), not a JS-Map docstore.
3. **Reference resolution:** reuse `@stackbase/client`'s `getFunctionPath` + `anyApi` proxy; accept typed refs and strings.
4. **Identity:** `t.withIdentity(string)` — native token model; divergence from Convex claims documented and asserted, not faked.
5. **`t.run`:** registered `_test:_run` slot mechanism (no engine change), with a runtime seam as an acceptable plan-time substitute.
6. **Conformance location:** inside `@stackbase/test`'s own test dir (dogfoods the harness + serves as its coverage).
7. **Clean-room:** study convex-test/concave demos for *which* behaviors; author all tests in our own words; never copy FSL code.
