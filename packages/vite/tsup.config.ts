import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Keep `ws` external: embed mode reaches it via a runtime dynamic `import("ws")`, resolved against
  // the project's own (Vite-transitive) install — never bundled in. `@helipod/cli` is already
  // externalized as an optional peer dependency.
  external: ["ws"],
});
