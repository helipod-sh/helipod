/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * The mode-"hash" fanOut real-workerd project (M2d) — a SIBLING of `vitest.workers.config.ts` (mode
 * "key"), pointed at its own fixture (`test-workers/test-worker-hash.ts` / `wrangler.hash.jsonc`).
 *
 * WHY a second config rather than one shared project: `@cloudflare/vitest-pool-workers` binds one
 * `SELF` (the default-exported Worker) and one `wrangler` config per project, and this package's
 * existing convention (mirrored from `packages/runtime-cloudflare`) runs `singleWorker: true` — every
 * test file inside ONE project shares that one Worker instance. fanOut requires a FIXED shard count
 * (`FANOUT_REQUIRES_FIXED_SHARDS`), which the mode-"key" fixture (`test-worker.ts`) structurally does
 * not have (§ `route.ts` — mode "key" has no enumerable shard set), so a mode-"hash" fixture is new
 * infrastructure, not a flag flip on the existing project. Run via `bun run test:workers` (chains both
 * projects — see `package.json`), or standalone: `bunx vitest run --config vitest.workers.hash.config.ts`.
 */
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test-workers/fanout.worker.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./test-workers/wrangler.hash.jsonc" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
