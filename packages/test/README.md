# @helipod/test

An in-process test harness for Helipod apps: `createTestHelipod` boots a real
`EmbeddedRuntime` — the actual transactor, query engine, and reactive subscription manager — over
an in-memory SQLite database, so your query/mutation/action tests exercise real behavior instead of
a mocked `ctx.db`.

See **[`docs/enduser/testing.md`](../../docs/enduser/testing.md)** for the full guide (the 3-layer
testing model, usage, and the documented differences from Convex's testing tooling).

## Public API

```ts
import { createTestHelipod, type TestHelipod, type CreateTestOptions, type TestSubscription } from "@helipod/test";
```

- `createTestHelipod(opts: CreateTestOptions): Promise<TestHelipod>` — boots a fresh, isolated
  backend (its own `:memory:` SQLite database and temp blob directory).
- `TestHelipod` — `query` / `mutation` / `action`, `run` (privileged, bypasses the public gate),
  `withIdentity`, `fetch`, `subscribe`, `finishScheduledFunctions` / `advanceTimers`, `close`.
- `CreateTestOptions` — `{ modules, components?, schema?, now? }`.
- `TestSubscription<T>` — the value returned by `t.subscribe(...)`: `value()`, `onChange(cb)`,
  `unsubscribe()`.

Always `await t.close()` — see the guide for isolation/cleanup guarantees.
