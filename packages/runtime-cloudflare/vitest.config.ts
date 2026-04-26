import { defineConfig } from "vitest/config";

// The DEFAULT (Node) suite — the API-shape host tests under `test/`. The real-workerd suite under
// `test-workers/` runs on a SEPARATE toolchain (`vitest.workers.config.ts`, invoked via `test:workers`)
// and MUST be excluded here: those files import `cloudflare:test`, which does not exist under Node.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
