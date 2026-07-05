import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // The routing layer runs on the Workers runtime, but it is plain JS (no node builtins) — the
  // engine/core deps it re-exports are already ESM. `platform: "neutral"` keeps the bundle free of
  // node-specific shims so it drops straight into a Worker. (The DO host it reuses lives in the free
  // `@helipod/runtime-cloudflare` package and is imported at the app's Worker entry, not bundled here.)
  platform: "neutral",
});
