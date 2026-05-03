import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // The host package targets a Worker/Durable-Object isolate, not Node — but the shared docstore /
  // engine deps it re-exports are `platform: "node"` builds, and workspace deps stay EXTERNAL (the
  // deploying app's own bundler — wrangler/esbuild — resolves them against the target's node_modules).
  // So `platform` here only affects this thin host layer, which uses no Node builtin.
  platform: "neutral",
});
