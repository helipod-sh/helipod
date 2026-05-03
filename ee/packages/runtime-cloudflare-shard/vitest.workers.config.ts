/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * The REAL-workerd test project (§ gate) — runs the multi-shard router + shard-DOs inside genuine
 * Durable Objects via `@cloudflare/vitest-pool-workers`, NOT under Node. Separate from the default
 * `vitest.config` (the Node routing-unit suite) so the two toolchains don't collide: run this with
 * `bun run test:workers` (or `bunx vitest run --config vitest.workers.config.ts`).
 *
 * Mirrors `packages/runtime-cloudflare/vitest.workers.config.ts`: isolatedStorage off (a live reactive
 * WebSocket keeps a DO busy across the per-test storage snapshot machinery; unique DO names give
 * isolation instead) and singleWorker on (multiple isolates trip a DO-class re-registration collision).
 */
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test-workers/**/*.worker.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./test-workers/wrangler.jsonc" },
        miniflare: {
          // `node:crypto` (the handler's drift/resume fingerprint) needs nodejs_compat.
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
