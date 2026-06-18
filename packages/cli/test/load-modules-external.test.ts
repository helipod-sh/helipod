/**
 * `STACKBASE_BUNDLE_EXTERNAL` escape hatch: a caller can widen bundle-on-load's `external` set
 * beyond `@stackbase/*`, for a dep that must NOT be bundled/inlined (the deferred follow-on from
 * the deploy-target-seam slice — see load-modules.ts's `extraBundleExternals`).
 *
 * Proves the *reason* this matters, not just that the env var is read: two convex function
 * modules (`a.ts`, `b.ts`) both import a CJS package that holds module-level counter state.
 *   - Default (no escape hatch): each module's bundle INLINES its own private copy of the
 *     package, so the two modules' counters are independent — bumping one never affects the other.
 *   - With STACKBASE_BUNDLE_EXTERNAL="singleton-lib": the import is left external, so both
 *     bundled modules resolve it through Node's own module cache at runtime and share ONE
 *     instance — bumping one is visible to the other, same as `@stackbase/*` singleton identity.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConvexDir } from "../src/load-modules";

function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sbloadext-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm);
  symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));

  // A minimal CJS package with module-level state — the shape a real singleton dep would have.
  const pkgDir = join(nm, "singleton-lib");
  mkdirSync(pkgDir);
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "singleton-lib", main: "index.js" }));
  writeFileSync(
    join(pkgDir, "index.js"),
    `let count = 0;\nmodule.exports = { bump: () => ++count };\n`,
  );

  writeFileSync(
    join(dir, "schema.ts"),
    `
    import { v, defineSchema, defineTable } from "@stackbase/values";
    export default defineSchema({ items: defineTable({ body: v.string() }) });
    `,
  );
  writeFileSync(
    join(dir, "a.ts"),
    `
    import lib from "singleton-lib";
    export const bumpA = () => lib.bump();
    `,
  );
  writeFileSync(
    join(dir, "b.ts"),
    `
    import lib from "singleton-lib";
    export const bumpB = () => lib.bump();
    `,
  );
  return dir;
}

describe("loadConvexDir — STACKBASE_BUNDLE_EXTERNAL escape hatch", () => {
  afterEach(() => {
    delete process.env.STACKBASE_BUNDLE_EXTERNAL;
  });

  it("without the escape hatch, each module inlines its own private copy (independent state)", async () => {
    const dir = makeFixture();
    const loaded = await loadConvexDir(dir);
    const bumpA = loaded.modules.a!.bumpA as () => number;
    const bumpB = loaded.modules.b!.bumpB as () => number;
    expect(bumpA()).toBe(1);
    expect(bumpA()).toBe(2);
    // b's inlined copy started its own counter at 0 — unaffected by a's bumps.
    expect(bumpB()).toBe(1);
  });

  it("with STACKBASE_BUNDLE_EXTERNAL, both modules share the one real module instance", async () => {
    process.env.STACKBASE_BUNDLE_EXTERNAL = "singleton-lib";
    const dir = makeFixture();
    const loaded = await loadConvexDir(dir);
    const bumpA = loaded.modules.a!.bumpA as () => number;
    const bumpB = loaded.modules.b!.bumpB as () => number;
    expect(bumpA()).toBe(1);
    // b resolves the SAME externalized module instance via Node's module cache — shared state.
    expect(bumpB()).toBe(2);
    expect(bumpA()).toBe(3);
  });
});
