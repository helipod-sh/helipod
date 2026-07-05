/**
 * `helipod serve` — production server. Fail-fast checks (no admin key, no `_generated/`) return
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
function makeFixtureFunctionsDir(withGenerated: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "sbserve-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm);
  symlinkSync(join(cliNodeModules(), "@helipod"), join(nm, "@helipod"));
  writeFileSync(
    join(dir, "schema.ts"),
    `
    import { v, defineSchema, defineTable } from "@helipod/values";
    export default defineSchema({ items: defineTable({ body: v.string() }) });
    `,
  );
  writeFileSync(
    join(dir, "app.ts"),
    `
    import { query } from "@helipod/executor";
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
  const OLD = process.env.HELIPOD_ADMIN_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.HELIPOD_ADMIN_KEY;
    else process.env.HELIPOD_ADMIN_KEY = OLD;
  });

  it("returns 1 with a clear message when HELIPOD_ADMIN_KEY is unset", async () => {
    delete process.env.HELIPOD_ADMIN_KEY;
    const dir = makeFixtureFunctionsDir(true);
    const code = await serveCommand(["--dir", dir]);
    expect(code).toBe(1);
  });

  it("returns 1 when --dir lacks _generated/", async () => {
    process.env.HELIPOD_ADMIN_KEY = "test-key";
    const dir = makeFixtureFunctionsDir(false);
    const code = await serveCommand(["--dir", dir]);
    expect(code).toBe(1);
  });
});

describe("startServe", () => {
  it("boots and serves /api/health", async () => {
    const fixtureDir = makeFixtureFunctionsDir(true);
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbserve-db-")), "db.sqlite");
    const { server, store } = await startServe({
      functionsDir: fixtureDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: false,
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

/**
 * `serve --web <dir>` — serve a static app frontend at the site root, same as `dev`'s `--web`.
 * The point is a SINGLE ORIGIN: an app served here reaches its sync WebSocket at `location.host`
 * with no backend-URL config and no cross-origin `/api/sync`. Proven by serving a real file and,
 * as a control, showing the same path 404s when `webDir` is unset (so a pass can't be vacuous).
 */
function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sbweb-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>packlist</title><div id=root>");
  writeFileSync(join(dir, "main.js"), "export const marker = 'WEB_BUNDLE_OK';");
  return dir;
}

describe("startServe --web", () => {
  it("serves index.html at / and static assets, on the same origin as /api/sync", async () => {
    const fixtureDir = makeFixtureFunctionsDir(true);
    const webDir = makeWebDir();
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbweb-db-")), "db.sqlite");
    const { server, store } = await startServe({
      functionsDir: fixtureDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: false,
      webDir,
    });
    try {
      // `/` → the app's index.html (the static fallback, since no route/handler claims `/`).
      const root = await fetch(`${server.url}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("<title>packlist</title>");

      // A static asset alongside it — same origin, so the client's `location.host` WS just works.
      const js = await fetch(`${server.url}/main.js`);
      expect(js.status).toBe(200);
      expect(await js.text()).toContain("WEB_BUNDLE_OK");

      // The API is unshadowed by the web fallback (the fallback only fires on an otherwise-404 GET).
      expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    } finally {
      await server.close();
      store.close();
    }
  });

  it("without --web, an app path 404s (the control — proves the test above isn't vacuous)", async () => {
    const fixtureDir = makeFixtureFunctionsDir(true);
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbweb-db-")), "db.sqlite");
    const { server, store } = await startServe({
      functionsDir: fixtureDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: false,
    });
    try {
      expect((await fetch(`${server.url}/main.js`)).status).toBe(404);
    } finally {
      await server.close();
      store.close();
    }
  });
});
