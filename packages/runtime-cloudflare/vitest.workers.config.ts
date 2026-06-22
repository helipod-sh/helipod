/**
 * The REAL-workerd test project (§6.1) — runs the DO-SQLite adapter conformance and the DO host
 * inside a genuine Durable Object via `@cloudflare/vitest-pool-workers`, NOT under Node. Separate from
 * the default `vitest.config`/`vitest run` (the Node/API-shape suite) so the two toolchains don't
 * collide: run this with `bunx vitest run --config vitest.workers.config.ts` (see README).
 */
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test-workers/**/*.worker.test.ts", "test-workers/**/*-e2e.test.ts"],
    poolOptions: {
      workers: {
        // A live reactive WebSocket keeps the DO busy across the test boundary, which the default
        // isolated-storage stacking (a per-test storage snapshot/rollback) cannot reconcile — it
        // asserts a clean pop that an open socket + pending fan-out violates. Each test here uses a
        // UNIQUE DO name for isolation instead, so turning the snapshot machinery off is safe.
        isolatedStorage: false,
        // Run all test files in ONE workerd instance. With multiple isolates, workerd trips an
        // internal DO-class re-registration collision ("inserted row already exists") — a known
        // miniflare quirk when several files share the same `new_sqlite_classes` bindings.
        singleWorker: true,
        wrangler: { configPath: "./test-workers/wrangler.jsonc" },
        miniflare: {
          // `node:crypto` (the handler's drift/resume fingerprint) needs nodejs_compat (§8.2).
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
