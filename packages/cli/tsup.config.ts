import { defineConfig } from "tsup";

export default defineConfig({
  // `http-handler` and `project` are additionally built as standalone subpath entries so a
  // Cloudflare-Worker/Durable-Object bundle (`@stackbase/runtime-cloudflare`, Slice 3) can reuse the
  // SHIPPED pure HTTP dispatcher (`handleHttpRequest`) and project-compose (`loadProject`) WITHOUT
  // pulling `server.ts`'s `node:http`/`ws` — which workerd cannot load. The `.` index still re-exports
  // both, so every existing importer is unchanged; the subpaths are purely additive. The `bin.ts`
  // shebang now lives in its source (not a global tsup `banner`, which would prepend it to every
  // entry including the importable subpaths).
  entry: ["src/index.ts", "src/bin.ts", "src/http-handler.ts", "src/project.ts"],
  format: ["esm"],
  dts: { entry: ["src/index.ts", "src/http-handler.ts", "src/project.ts"] },
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "node",
});
