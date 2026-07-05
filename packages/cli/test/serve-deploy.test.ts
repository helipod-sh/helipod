/**
 * `serve --allow-deploy` flag plumbing + the default-off gate on `POST /_admin/deploy`.
 * The full happy-path deploy (a real additive schema change hot-swapped live) is proven in
 * `deploy-apply.test.ts` (mechanism) and the deploy E2E (Task 6) through this same `startServe`
 * entry point. Here: (a) `resolveServeOptions` parses the flag/env var, (b) without the flag the
 * endpoint is unreachable (falls through to the admin router's generic 404), (c) with the flag the
 * endpoint IS reachable and returns a deploy-shaped response, not the generic 404.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveServeOptions, startServe } from "../src/serve";

/** Resolve a package from the CLI's own node_modules (already linked by the workspace install). */
function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

/** A minimal real convex/ dir — enough for bootProject (which never reads _generated/). */
function makeFixtureFunctionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sbservedeploy-"));
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
  return dir;
}

describe("resolveServeOptions — --allow-deploy / HELIPOD_ALLOW_DEPLOY", () => {
  const OLD = process.env.HELIPOD_ALLOW_DEPLOY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.HELIPOD_ALLOW_DEPLOY;
    else process.env.HELIPOD_ALLOW_DEPLOY = OLD;
  });

  it("defaults to false", () => {
    delete process.env.HELIPOD_ALLOW_DEPLOY;
    expect(resolveServeOptions([]).allowDeploy).toBe(false);
  });

  it("--allow-deploy sets it true", () => {
    delete process.env.HELIPOD_ALLOW_DEPLOY;
    expect(resolveServeOptions(["--allow-deploy"]).allowDeploy).toBe(true);
  });

  it("HELIPOD_ALLOW_DEPLOY=1 sets it true", () => {
    process.env.HELIPOD_ALLOW_DEPLOY = "1";
    expect(resolveServeOptions([]).allowDeploy).toBe(true);
  });

  it("HELIPOD_ALLOW_DEPLOY unset or any other value stays false", () => {
    process.env.HELIPOD_ALLOW_DEPLOY = "true";
    expect(resolveServeOptions([]).allowDeploy).toBe(false);
  });
});

describe("startServe — POST /_admin/deploy gated by allowDeploy", () => {
  it("WITHOUT --allow-deploy: falls through to the admin router's generic 404 — endpoint not registered", async () => {
    const functionsDir = makeFixtureFunctionsDir();
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbservedeploy-db-")), "db.sqlite");
    const { server, store } = await startServe({
      functionsDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: false,
    });
    try {
      const res = await fetch(`${server.url}/_admin/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({ files: [] }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      // The generic admin-router 404 — no `ok`/`kind` fields, proving the deploy handler never ran.
      expect(body).toEqual({ error: "not found" });
    } finally {
      await server.close();
      store.close();
    }
  });

  it("WITH --allow-deploy: the endpoint is reachable and returns a deploy-shaped response", async () => {
    const functionsDir = makeFixtureFunctionsDir();
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbservedeploy-db-")), "db.sqlite");
    const { server, store } = await startServe({
      functionsDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: true,
    });
    try {
      const res = await fetch(`${server.url}/_admin/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({ files: [] }),
      });
      // An empty file set fails to load (no schema.ts in the fresh per-rev deploy dir) — the
      // load-bearing assertion here is the SHAPE of the response (deploy ran), not the outcome.
      expect(res.status).not.toBe(404);
      const body = (await res.json()) as { ok?: boolean; kind?: string; error?: string };
      expect(body.ok).toBe(false);
      expect(body.kind).toBe("load-error");
    } finally {
      await server.close();
      store.close();
    }
  });

  it("WITH --allow-deploy but a bad admin key: unauthorized, not a generic 404", async () => {
    const functionsDir = makeFixtureFunctionsDir();
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbservedeploy-db-")), "db.sqlite");
    const { server, store } = await startServe({
      functionsDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: true,
    });
    try {
      const res = await fetch(`${server.url}/_admin/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({ files: [] }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
      store.close();
    }
  });
});
