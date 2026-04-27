/**
 * THROWAWAY SPIKE probe (Slice 4). Honest evidence that the INSTALLED toolchain (miniflare
 * 3.20241218.0 / workerd 1.20241218.0, both Dec 2024) has NO Worker Loader — so the spike's
 * real-CF claims cannot be locally proven and are marked INFERRED, not PROVEN. See ./README.md.
 *
 * Run from the repo root:  node packages/runtime-cloudflare/spike-worker-loader/probe-local.mjs
 *
 * OBSERVED RESULT (2026-07-16, this repo): "RESULT: 500 NO_LOADER_BINDING" — i.e. env.LOADER is
 * undefined; the Dec-2024 miniflare silently ignores `workerLoaders`. (If a future toolchain bump
 * makes this print "child ok", Worker Loader has landed locally and the spike can move to vitest.)
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve miniflare from the repo's installed deps (bun nests it under node_modules/.bun).
const require = createRequire(import.meta.url);
let Miniflare;
function tryResolve() {
  try {
    return require.resolve("miniflare");
  } catch {
    const hit = execSync(
      "find node_modules/.bun/miniflare@* -path '*dist/src/index.js' 2>/dev/null | head -1",
      { encoding: "utf8" },
    ).trim();
    return hit || null;
  }
}
const path = tryResolve();
if (!path) {
  console.log("miniflare not resolvable — run from the repo root (needs node_modules/.bun).");
  process.exit(0);
}
({ Miniflare } = await import(pathToFileURL(resolve(path)).href));

const script = `export default { async fetch(req, env) {
  if (!env.LOADER) return new Response("NO_LOADER_BINDING", { status: 500 });
  const w = env.LOADER.load({ compatibilityDate: "2026-06-24", mainModule: "m.js",
    modules: { "m.js": "export default { fetch(){ return new Response('child ok') } }" },
    globalOutbound: null });
  return w.getEntrypoint().fetch(req);
} }`;

try {
  const mf = new Miniflare({
    modules: true,
    script,
    workerLoaders: [{ binding: "LOADER" }], // the documented binding shape; ignored pre-2026-03
    compatibilityDate: "2024-11-27",
  });
  const res = await mf.dispatchFetch("http://x/");
  console.log("RESULT:", res.status, (await res.text()).slice(0, 200));
  await mf.dispose();
} catch (e) {
  console.log("PROBE THREW (toolchain lacks Worker Loader):");
  console.log(String(e.stack || e).split("\n").slice(0, 6).join("\n"));
}
