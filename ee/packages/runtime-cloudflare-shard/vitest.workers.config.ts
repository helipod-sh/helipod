/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * The REAL-workerd test project (§ gate) — runs the multi-shard router + shard-DOs inside genuine
 * Durable Objects via `@cloudflare/vitest-pool-workers`, NOT under Node. Separate from the default
 * `vitest.config` (the Node routing-unit suite) so the two toolchains don't collide: run this with
 * `bun run test:workers` (or `bunx vitest run --config vitest.workers.config.ts`).
 *
 * Mirrors `packages/runtime-cloudflare/vitest.workers.config.ts`: isolatedStorage off (a live reactive
 * WebSocket keeps a DO busy across the per-test storage snapshot machinery; unique DO names give
 * isolation instead) and singleWorker on (multiple isolates trip a DO-class re-registration collision).
 *
 * Excludes `fanout.worker.test.ts` (M2d): that file targets the mode-"hash" fixture, which needs a
 * FIXED shard count this project's fixture (`test-worker.ts`, mode "key") does not have — it runs in
 * its own project, `vitest.workers.hash.config.ts` / `wrangler.hash.jsonc`. `bun run test:workers`
 * chains both.
 */
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { defaultExclude } from "vitest/config";

export default defineWorkersConfig({
  test: {
    include: ["test-workers/**/*.worker.test.ts"],
    exclude: [...defaultExclude, "test-workers/fanout.worker.test.ts"],
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
