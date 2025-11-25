import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/react.tsx", "src/outbox-fs.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["react", "react/jsx-runtime"],
  // Keep the "node:" protocol on builtin specifiers in the emitted bundle (tsup strips it to the
  // bare form by default) so dist/outbox-fs.js is unambiguously distinguishable from the browser
  // entrypoints (index.js/react.js) by a `node:` grep — see test/dist-browser-clean.test.ts.
  removeNodeProtocol: false,
});
