import { defineConfig } from "tsup";
import { resolve } from "node:path";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["@opentui/core", "@opentui/react", "react"],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.alias = { "@": resolve(__dirname, "src") };
  },
});
