---
title: Testing
---

# Testing

> Write real queries/mutations/actions against a real in-memory backend — no mocks, no fixtures for the engine itself.

Stackbase functions run inside a transactional, reactive engine, so a good test needs a real
transaction and a real subscription manager, not a hand-rolled stub of `ctx.db`. `@stackbase/test`
gives you exactly that: a full `EmbeddedRuntime` over an in-memory SQLite database, spun up and
torn down per test in milliseconds.

## The 3-layer model

Stackbase tests exist at three levels. Each is real code exercising a real path — they differ in
how much of the surrounding process (CLI, HTTP, OS) is involved.

| Layer | What runs | Where it lives | What it proves |
|---|---|---|---|
| **1. Unit / in-process** | `@stackbase/test`'s `createTestStackbase` — a real engine (transactor, query engine, reactivity) over SQLite `:memory:`, all in the test process | `packages/*/test/**`, `components/*/test/**`, your app's own test suite | Function correctness, reactive invalidation, schema/index behavior — fast, no process boundary |
| **2. End-to-end** | The actual `stackbase dev`/`stackbase serve` server, started as a real child process, driven over real HTTP/WebSocket | `packages/cli/test/*-e2e.test.ts` | The CLI boot path, hot reload, the wire protocol, and cross-cutting features (deploy, Docker, storage) that only exist once the server is actually listening |
| **3. Cross-runtime** | The same engine logic, run under both Node and Bun | The vitest suite runs under Node; `docstore-sqlite` additionally has a `bun run test:bun` smoke test, and `packages/cli/test/build-e2e.test.ts` exercises a real `bun build --compile` binary | That the engine doesn't secretly depend on one runtime's APIs |

This page is about **Layer 1** — the layer you'll use for your own app's functions. Layers 2 and 3
are how Stackbase itself is tested; see `packages/cli/test/*-e2e.test.ts` in the repo if you want
the pattern for driving a real server from a test.

## Getting started

```ts
import { createTestStackbase } from "@stackbase/test";
import * as messages from "./messages";
import schema from "./schema";

const t = await createTestStackbase({
  modules: { "messages.ts": messages, "schema.ts": { default: schema } },
});

try {
  const id = await t.mutation("messages:send", { body: "hi" });
  const rows = await t.query("messages:list", {});
  // ...assertions...
} finally {
  await t.close();
}
```

`createTestStackbase` is **async** — always `await` it. It boots a real `EmbeddedRuntime`: MVCC
SQLite storage, the transactor, the query engine, and (if you compose any) components like
`@stackbase/scheduler`.

### The `modules` map

`modules` is a flat map from a Convex-style module path (`"messages.ts"`) to that module's
exports. Two shapes work:

**Explicit**, importing each file yourself:

```ts
import * as messages from "./messages";
import * as users from "./users";
import schema from "./schema";

const t = await createTestStackbase({
  modules: {
    "messages.ts": messages,
    "users.ts": users,
    "schema.ts": { default: schema },
  },
});
```

**`import.meta.glob`**, letting your bundler enumerate the directory for you (the non-eager form —
a map of lazy loaders — works as-is; each is awaited before use):

```ts
const t = await createTestStackbase({
  modules: import.meta.glob("./convex/**/*.ts"),
});
```

A `schema.ts` entry (default-exported `defineSchema(...)`) is picked up automatically — this is
what `schema: "auto"` (the default) means: resolve the schema from whatever `schema.ts` is in
`modules`, if any. Pass an explicit `SchemaDefinition` instead if you want to override it, or
`schema: false` for no schema at all.

### Composing components

If your app opts into components (in `stackbase.config.ts`), list them the same way in the test:

```ts
import { defineScheduler } from "@stackbase/scheduler";

const t = await createTestStackbase({
  modules: { /* ... */ },
  components: [defineScheduler()],
});
```

Without `defineScheduler()` here, `t.finishScheduledFunctions()`/`t.advanceTimers()` are harmless
no-ops (there's no scheduler driver to drive) rather than errors.

## Function references

Both a `"module:fn"` string path and a typed proxy reference work anywhere a `FunctionReference` is
expected — `t.query`, `t.mutation`, `t.action`, `t.subscribe`:

```ts
import { anyApi } from "@stackbase/client";
// or, with generated types: import { api } from "./convex/_generated/api";

await t.query("messages:list", {});
await t.query((anyApi as any).messages.list, {});
```

Use your codegen'd `api`/`internal` (cast through `anyApi` if you don't have generated types in the
test) for compile-time checking, or bare strings when that's more convenient — they resolve to the
exact same function.

## API surface

- **`t.query(ref, args)` / `t.mutation(ref, args)` / `t.action(ref, args)`** — call a function as
  a client would, through the public gate (identity, if any, is whatever `t.withIdentity` set).
- **`t.run(fn)`** — runs `fn` with a full, privileged database-writer `ctx` inside one real
  transaction, bypassing the public gate entirely. Use it for setup/seeding or assertions that
  shouldn't have to go through an app-defined mutation:

  ```ts
  const id = await t.run(async (ctx) => ctx.db.insert("messages", { body: "seeded" }));
  ```

- **`t.withIdentity(token)`** — returns a view of the *same* backend whose calls carry `token` as
  the ambient identity. See [Differences from Convex](#differences-from-convex) below — this is a
  raw string, not a claims object.
- **`t.fetch(request)`** — routes a `Request` through your app's `http.ts` router exactly as the
  real server's HTTP handler would, returning a `Response` (a plain 404 for no match). The calling
  view's identity (via `withIdentity`) takes precedence over the request's own `Authorization`
  header if both are present. This override is a harness convenience only — in production an
  httpAction's identity comes solely from the request's own `Authorization` header.
- **`t.subscribe(ref, args)`** — see below.
- **`t.finishScheduledFunctions()` / `t.advanceTimers(ms)`** — deterministic time control for
  `@stackbase/scheduler` jobs and crons, driven by the harness's own virtual clock (no real
  timers/sleeps). `finishScheduledFunctions` drains everything currently and eventually due
  (including cascades) to completion; `advanceTimers` moves the clock by exactly `ms` and drives one
  pass. Both are no-ops without a composed scheduler.
- **`t.close()`** — always call this, in a `try/finally` or an `afterEach`. It tears down the
  in-memory database, stops any component drivers, and removes the temp directory backing file
  storage. Skipping it doesn't corrupt anything else (each instance is isolated — see below), but it
  will leak resources within a long test run.

## `t.subscribe` — testing reactivity itself

```ts
const sub = t.subscribe("messages:list", {});
sub.onChange((rows) => { /* ... */ });

await t.mutation("messages:send", { body: "hi" });
// sub.value() is now re-computed and re-pushed — because the write's write set
// intersected the query's recorded read set, not because anything was polled.

sub.unsubscribe();
```

`t.subscribe` runs the **real** client → sync protocol → `SubscriptionManager` → engine path over
an in-process loopback connection — not a simulated re-render. A committed write only triggers a
re-push when its write set intersects the subscription's recorded read set, exactly as it would
over a live WebSocket. This is a capability `convex-test` doesn't have: asserting that a specific
mutation *does* invalidate one subscription and *doesn't* invalidate an unrelated one is a real,
first-class test in Stackbase, not something you have to fake by re-running the query yourself.

## Isolation and cleanup

Every `createTestStackbase()` call is a fully independent backend: its own SQLite `:memory:`
database, its own temp directory for file storage, its own set of component drivers. Two instances
in the same test file never see each other's writes. Always pair creation with `t.close()`:

```ts
afterEach(async () => {
  await t.close();
});
```

## Differences from Convex

If you're porting tests written against Convex's testing tooling, these are the places behavior
diverges:

- **Identity is a raw string token, not a claims object.** `t.withIdentity("some-token")` sets the
  ambient token the app's own auth component resolves — it's surfaced to functions through a
  context provider (e.g. `ctx.auth`), not a bare `ctx.identity` populated from JWT claims. What the
  token resolves to is entirely up to your auth component.
- **Index reads use a chained query builder, not `.withIndex(cb)`.** Range predicates chain
  directly off `ctx.db.query(table, index)`:

  ```ts
  ctx.db.query("docs", "by_owner").eq("owner", "a").gte("n", 1).lt("n", 3).order("asc").collect();
  ```

- **Pagination returns a different shape.** `.paginate({ cursor, pageSize })` returns
  `{ page, nextCursor, hasMore, scanCapped }` — not Convex's `{ isDone, continueCursor }`.
  `hasMore` is `!isDone`; `nextCursor` is `continueCursor`.
- **There is no `ctx.db.patch`.** A partial update is a read, a merge, and a `ctx.db.replace(id,
  merged)`.
- **Schema document validation is runtime-enforced.** Stackbase's `v.*` validators give you
  TypeScript types AND are checked on every write — an insert or `replace` whose document is
  wrong-typed, has an extra field, or is missing a required field is rejected with a
  `DocumentValidationError` ("document in \"<table>\" does not match schema: ..."). Disable it for
  an entire schema with `defineSchema(tables, { schemaValidation: false })`, or loosen a single
  field with `v.any()`.

## CI

`@stackbase/test` runs under plain vitest — no special CI setup beyond what you already have for
the rest of the monorepo:

```yaml
# .github/workflows/test.yml (excerpt)
- run: bun install
- run: bun run test   # runs vitest under Bun; equally fine under Node
```

## See also

- [File Storage](/files) — `ctx.storage` works the same way in tests as in production (a temp
  filesystem-backed blob store, torn down in `t.close()`).
- [`stackbase deploy`](/deploying) — for the deployment story once your functions are tested; the
  end-to-end (Layer 2) tests in `packages/cli/test/deploy-e2e.test.ts` show the same functions
  driven through a real running server instead of `@stackbase/test`.
