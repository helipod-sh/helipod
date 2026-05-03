import { defineConfig } from "vitest/config";

// The DEFAULT (Node) suite — the pure routing/canonicalization tests under `test/`. The real-workerd
// suite under `test-workers/` runs on a SEPARATE toolchain (`vitest.workers.config.ts`, invoked via
// `test:workers`) and MUST be excluded here: those files import `cloudflare:test`, absent under Node.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
