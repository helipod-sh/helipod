import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These are in-process integration tests over real embedded infrastructure;
    // vitest's 5s default is calibrated for unit tests and starves them on
    // cold-cache CI runners.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
