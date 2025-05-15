---
title: Testing
---

# Testing

> Test your Convex functions using convex-test or against a running Stackbase server.

Test your backend functions using the standard Convex testing tools or by running tests against a Stackbase server.

## Convex documentation

For testing patterns and the `convex-test` library:

- [Testing](https://docs.convex.dev/testing) - Overview
- [convex-test](https://docs.convex.dev/testing/convex-test) - Unit testing library

---

## Running functions from CLI

Use `stackbase run` to execute functions directly:

```bash
# Run a query
npx stackbase run tasks:list

# Run with arguments
npx stackbase run tasks:create '{"title": "Test task"}'

# Run against a specific server
npx stackbase run --url http://localhost:3000 tasks:list
```

---

## Unit testing with convex-test

The `convex-test` library works with Stackbase since it tests your Convex functions in isolation:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

describe("tasks", () => {
  const t = convexTest(schema);

  it("creates a task", async () => {
    const taskId = await t.mutation(api.tasks.create, { title: "Test" });
    const task = await t.query(api.tasks.get, { id: taskId });
    expect(task?.title).toBe("Test");
  });
});
```

This uses an in-memory backend, not Stackbase, but validates your function logic.

---

## E2E testing against Stackbase

For integration tests against a real Stackbase server:

```ts
// tests/e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createStackbase, SqliteDocStore } from "@stackbase/runtime-bun";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

let server: ReturnType<typeof createStackbase>;
let client: ConvexHttpClient;

beforeAll(async () => {
  server = createStackbase({
    convexDir: "./convex",
    docstore: new SqliteDocStore(":memory:"), // In-memory for tests
    schema: "skip",
  });
  await server.listen({ port: 3999, hostname: "127.0.0.1" });
  client = new ConvexHttpClient("http://localhost:3999");
});

afterAll(async () => {
  await server.close();
});

describe("E2E: Tasks", () => {
  it("creates and retrieves a task", async () => {
    const taskId = await client.mutation(api.tasks.create, {
      title: "E2E Test",
    });

    const task = await client.query(api.tasks.get, { id: taskId });
    expect(task?.title).toBe("E2E Test");
  });
});
```

For Node.js, use `@stackbase/runtime-node` with the same API.

---

## Testing strategy

### When to use each approach

| Approach | Speed | Coverage | Best for |
|----------|-------|----------|----------|
| `convex-test` | Fast | Logic only | Unit tests, TDD |
| E2E (single runtime) | Medium | Runtime behavior | Integration tests |
| Cross-runtime E2E | Slow | Full compatibility | Pre-deploy verification |

### Cross-runtime testing

To ensure your app works across all runtimes, run E2E tests against each:

```ts
// tests/cross-runtime.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const runtimes = [
  { name: "bun", module: "@stackbase/runtime-bun" },
  { name: "node", module: "@stackbase/runtime-node" },
];

for (const runtime of runtimes) {
  describe(`E2E: ${runtime.name}`, () => {
    let server: any;
    let client: ConvexHttpClient;
    const port = 3900 + runtimes.indexOf(runtime);

    beforeAll(async () => {
      const { createStackbase, SqliteDocStore } = await import(runtime.module);
      server = createStackbase({
        convexDir: "./convex",
        docstore: new SqliteDocStore(":memory:"),
        schema: "skip",
      });
      await server.listen({ port, hostname: "127.0.0.1" });
      client = new ConvexHttpClient(`http://localhost:${port}`);
    });

    afterAll(async () => {
      await server.close();
    });

    it("creates and retrieves documents", async () => {
      const id = await client.mutation(api.tasks.create, { title: "Test" });
      const task = await client.query(api.tasks.get, { id });
      expect(task?.title).toBe("Test");
    });
  });
}
```

**Note**: Node.js tests require `--experimental-sqlite` flag. Add to your test script:

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

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test:e2e
```

---

## Common questions

- **Should I use convex-test or E2E tests?** Use `convex-test` for fast unit tests; E2E for runtime-specific behavior.
- **Can I test Cloudflare Workers locally?** Yes, use `wrangler dev` or the Miniflare simulator.
- **How do I reset the database between tests?** Use `:memory:` for SQLite, or truncate tables in a `beforeEach` hook.

---

