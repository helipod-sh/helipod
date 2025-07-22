/**
 * `stackbase serve` — production server. Fail-fast checks (no admin key, no `_generated/`) return
 * 1 without ever starting a server; `startServe` is the testable core that boots + serves without
 * signal handlers or blocking, proven here through a real `/api/health` round trip.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serveCommand, startServe } from "../src/serve";

/** Resolve a package from the CLI's own node_modules (already linked by the workspace install). */
function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

/**
 * Build a temp `convex/` dir with a real schema.ts + one query module (dynamically importable,
 * like a real project) and optionally a `_generated/server.ts` stub — enough for `bootProject`
 * (which never reads `_generated/`) and for the `serveCommand` fail-fast existence check.
 */
function makeFixtureConvexDir(withGenerated: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "sbserve-"));
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
    join(dir, "app.ts"),
    `
    import { query } from "@stackbase/executor";
    export const list = query({ handler: async () => [] });
    `,
  );
  if (withGenerated) {
    mkdirSync(join(dir, "_generated"));
    writeFileSync(join(dir, "_generated", "server.ts"), "// stub generated file\n");
  }
  return dir;
}

describe("serveCommand fail-fast", () => {
  const OLD = process.env.STACKBASE_ADMIN_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.STACKBASE_ADMIN_KEY;
    else process.env.STACKBASE_ADMIN_KEY = OLD;
  });

  it("returns 1 with a clear message when STACKBASE_ADMIN_KEY is unset", async () => {
    delete process.env.STACKBASE_ADMIN_KEY;
    const dir = makeFixtureConvexDir(true);
    const code = await serveCommand(["--dir", dir]);
    expect(code).toBe(1);
  });

  it("returns 1 when --dir lacks _generated/", async () => {
    process.env.STACKBASE_ADMIN_KEY = "test-key";
    const dir = makeFixtureConvexDir(false);
    const code = await serveCommand(["--dir", dir]);
    expect(code).toBe(1);
  });
});

describe("startServe", () => {
  it("boots and serves /api/health", async () => {
    const fixtureDir = makeFixtureConvexDir(true);
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbserve-db-")), "db.sqlite");
    const { server, store } = await startServe({
      convexDir: fixtureDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
    });
    try {
      const res = await fetch(`${server.url}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
      store.close();
    }
  });
});
