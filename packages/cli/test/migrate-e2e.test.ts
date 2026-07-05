/**
 * E2E: a migrated Convex fixture is a VALID Helipod app — it loads via loadProject and a
 * migrated mutation runs on the embedded engine. Proves the migration output is real, not just
 * a text rewrite. ("Test through the shipped entrypoint.")
 *
 * Uses a crons-free fixture (`convex-app-basic`) rather than `fixtures/convex-app`: that fixture
 * has a `crons.ts` which is intentionally left as an unrewritten `convex/server` import
 * (action-needed, not auto-fixed) and whose scaffolded `helipod.config.ts` composes the real
 * `@helipod/scheduler` (which itself needs `cron-parser`) — heavy infra irrelevant to what this
 * task is proving. `convex-app-basic` migrates to ONLY `@helipod/*` + `./_generated/server`
 * imports, so no `convex` stub and no scheduler/`cron-parser` symlinks are needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { migrateCommand } from "../src/migrate";
import { loadFunctionsDir } from "../src/load-modules";
import { loadProject } from "../src/project";

/** Resolve the CLI package's own node_modules (already linked by the workspace install). */
function cliNodeModules(): string {
  return resolve(__dirname, "..", "node_modules");
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbmig-e2e-"));
  cpSync(join(__dirname, "fixtures", "convex-app-basic"), root, { recursive: true });

  // The migrated schema.ts imports "@helipod/values", and the regenerated
  // `_generated/server.ts` re-exports from "@helipod/executor" — the temp dir lives outside
  // the workspace, so it has no node_modules of its own to resolve those bare specifiers from.
  // Symlink the whole @helipod scope from the CLI package's own install, same precedent as
  // `load-config.test.ts`'s `makeTmpDir` and `migrate-command.test.ts`'s `beforeEach`.
  const nm = join(root, "node_modules");
  mkdirSync(nm, { recursive: true });
  symlinkSync(join(cliNodeModules(), "@helipod"), join(nm, "@helipod"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("migrate E2E", () => {
  it("migrated fixture loads and a migrated mutation runs on the engine", async () => {
    expect(await migrateCommand(["--dir", join(root, "convex"), "--force"])).toBe(0);

    const loaded = await loadFunctionsDir(join(root, "helipod"));
    const project = loadProject(loaded);
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });

    const res = await runtime.run<string>("notes:add", { body: "hello" });
    expect(typeof res.value).toBe("string"); // the migrated mutation committed and returned an id
  });
});
