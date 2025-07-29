/**
 * `loadConvexDir` must load `.js` modules as well as `.ts` — the tree `stackbase deploy` pushes
 * is transpiled JS, not TypeScript. Mirrors the fixture-dir pattern from `serve.test.ts` (a real
 * `schema.js` + one query module, symlinked into a `node_modules/@stackbase` so the dynamic
 * `import()` can resolve workspace packages), but writes plain JS instead of TS.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConvexDir } from "../src/load-modules";

/** Resolve a package from the CLI's own node_modules (already linked by the workspace install). */
function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

function makeJsFixtureConvexDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sbloadjs-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm);
  symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));
  writeFileSync(
    join(dir, "schema.js"),
    `
    import { v, defineSchema, defineTable } from "@stackbase/values";
    export default defineSchema({ items: defineTable({ body: v.string() }) });
    `,
  );
  writeFileSync(
    join(dir, "foo.js"),
    `
    import { query } from "@stackbase/executor";
    export const list = query({ handler: async () => [] });
    `,
  );
  return dir;
}

describe("loadConvexDir — .js support", () => {
  it("loads schema.js + .js function modules", async () => {
    const dir = makeJsFixtureConvexDir();
    const loaded = await loadConvexDir(dir);
    expect(loaded.schema).toBeDefined();
    expect(loaded.schema.export().tables).toHaveProperty("items");
    expect(Object.keys(loaded.modules)).toContain("foo");
    expect(loaded.modules.foo).toBeDefined();
    expect(loaded.modules.foo!.list).toBeDefined();
  });

  it("still loads an all-.ts project (no regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbloadts-"));
    const nm = join(dir, "node_modules");
    mkdirSync(nm);
    symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));
    writeFileSync(
      join(dir, "schema.ts"),
      `
      import { v, defineSchema, defineTable } from "@stackbase/values";
      export default defineSchema({ items: defineTable({ body: v.string() }) });
      `,
    );
    writeFileSync(
      join(dir, "foo.ts"),
      `
      import { query } from "@stackbase/executor";
      export const list = query({ handler: async () => [] });
      `,
    );
    const loaded = await loadConvexDir(dir);
    expect(loaded.schema.export().tables).toHaveProperty("items");
    expect(Object.keys(loaded.modules)).toContain("foo");
  });
});
