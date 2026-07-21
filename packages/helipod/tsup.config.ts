import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/values.ts",
    "src/react.ts",
    "src/config.ts",
    "src/outbox-fs.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
