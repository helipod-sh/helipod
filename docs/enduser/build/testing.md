---
title: Testing
---

# Testing

> Test your functions with `@stackbase/test`, or end-to-end against a running server.

> **The full, accurate testing guide is [Testing](/testing).** This page is a short orientation;
> that one is written against the shipped harness.

## The real harness: `@stackbase/test`

Stackbase ships its own test harness, `@stackbase/test`, which runs your functions against the
**real engine** (real transactor, real query engine, real reactivity) rather than a simulation:

```ts
import { describe, it, expect } from "vitest";
import { createTestStackbase } from "@stackbase/test";
import { api } from "./_generated/api";
import schema from "./schema";

describe("tasks", () => {
  it("creates a task", async () => {
    const t = createTestStackbase({ schema });
    const taskId = await t.mutation(api.tasks.create, { title: "Test" });
    const task = await t.query(api.tasks.get, { id: taskId });
    expect(task?.title).toBe("Test");
  });
});
```

It also supports `t.subscribe(...)` for asserting reactive behavior — a capability a
logic-only unit harness can't offer. See [Testing](/testing) for the full API, the conformance
suite, and the documented divergences from Convex's harness.

### Migrating from `convex-test`

If you're coming from Convex, you may be using
[`convex-test`](https://docs.convex.dev/testing/convex-test). It is **not** the Stackbase harness —
use `@stackbase/test` instead. `stackbase migrate` handles your import rewrites; see
[Convex Compatibility](/reference/compatibility).

---

## E2E testing against a running server

For integration tests against a real server, start `stackbase dev` (or a
[compiled binary](/deploy/standalone-binary)) and drive it with `@stackbase/client` over a real
WebSocket, or call `POST /api/run` over HTTP. This is exactly how Stackbase's own end-to-end tests
work — see `packages/cli/test/` in the repo for worked examples.

> There is **no `stackbase run` command** and **no `createStackbase` API**. Earlier versions of this
> page described both; neither exists. Use `POST /api/run`, the dashboard's function runner, or the
> client SDK.

---

## Testing strategy

| Approach | Speed | Coverage | Best for |
|----------|-------|----------|----------|
| `@stackbase/test` | Fast | Real engine semantics, incl. reactivity | Unit tests, TDD |
| E2E vs. a running server | Medium | Full transport + server behavior | Integration tests |

### Cross-runtime testing

> 🚧 **Planned — not yet shipped.** A turnkey cross-runtime test matrix (asserting your app behaves
> identically under Bun and Node) is intended but not built. Today you can approximate it by running
> your E2E suite twice, once under each runtime.

**Note**: Node.js tests require the `--experimental-sqlite` flag:

```json
{
  "scripts": {
    "test:e2e": "NODE_OPTIONS='--experimental-sqlite --experimental-vm-modules' vitest run tests/"
  }
}
```

---

## CI configuration

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test
```

---

## Common questions

- **Which harness should I use?** `@stackbase/test` for unit tests; E2E against a running server
  for transport-level behavior.
- **Does `convex-test` work?** It's Convex's harness, not ours — use `@stackbase/test`.
- **How do I reset the database between tests?** `createTestStackbase()` gives each test a fresh
  in-memory engine.

---
