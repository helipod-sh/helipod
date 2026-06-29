import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, "..", "dist", "bin.js");
const fixtureSrc = join(here, "fixtures", "conventional-app", "convex");
// The CLI package dir (packages/cli), NOT the monorepo root. `resolveCacheDir` in
// load-modules.ts walks UP from the functions dir to the nearest ancestor that literally
// contains a `node_modules` folder, then bundles+caches there so the bundle's external
// `@stackbase/*` imports resolve via Node's own ancestor walk. In a real end-user project
// (single package.json, single node_modules with @stackbase/* installed from the registry)
// the repo root IS that node_modules. But in THIS monorepo, bun's workspace linker does not
// hoist workspace packages to the root node_modules — it symlinks them per-consumer, so only
// `packages/cli/node_modules/@stackbase/*` (this package's own dependencies) actually has
// them; the root node_modules only holds hoisted third-party deps. Anchoring the throwaway
// dir under repoRoot (as an earlier draft of this test did) reproduced a DIFFERENT failure
// (ERR_MODULE_NOT_FOUND for @stackbase/values) that has nothing to do with bundle-on-load —
// it's just this monorepo's isolated linking not matching a real project's flat layout.
// Anchoring under packages/cli instead faithfully models "a node_modules that has the deps",
// matching how the existing deploy-e2e/build-e2e fixtures already resolve (they live under
// packages/cli/test/fixtures, inheriting packages/cli/node_modules).
const cliPackageDir = join(here, ".."); // packages/cli/test → packages/cli

/** Copy the fixture to a throwaway functions dir under packages/cli (so the bundled .mjs's
 *  external @stackbase/* imports resolve from packages/cli's own node_modules — see the
 *  comment on cliPackageDir above), run codegen via `runner`, and return { ok, out }.
 *  `_generated` is kept in place — notes.ts imports ./_generated/server, so removing it up
 *  front would break the load before codegen ever gets a chance to regenerate it. Success is
 *  judged on the SIGNAL (stdout contains "generated" and no ERR_MODULE_NOT_FOUND), not exit
 *  code alone — the old broken path exits 0 too. Cleans up the throwaway dir in `finally`. */
function codegenWith(runner: string): { ok: boolean; out: string } {
  const tmp = mkdtempSync(join(cliPackageDir, ".tmp-node-load-"));
  const functionsDir = join(tmp, "stackbase");
  cpSync(fixtureSrc, functionsDir, { recursive: true }); // keep _generated — notes.ts imports it
  try {
    const out = execFileSync(runner, [cliBin, "codegen", "--dir", functionsDir], { encoding: "utf8", stdio: "pipe" });
    return { ok: /generated/.test(out) && !/ERR_MODULE_NOT_FOUND/.test(out), out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("CLI loads a conventional (./_generated/server) app across runtimes", () => {
  it("codegen succeeds under NODE (the runtime that failed before bundle-on-load)", () => {
    const r = codegenWith(process.execPath); // node
    expect(r.ok, `node codegen output:\n${r.out}`).toBe(true);
  });

  it("codegen still succeeds under BUN", () => {
    const r = codegenWith("bun");
    expect(r.ok, `bun codegen output:\n${r.out}`).toBe(true);
  });
});
