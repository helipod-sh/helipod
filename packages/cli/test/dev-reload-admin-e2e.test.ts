/**
 * Regression test for issue #1: `helipod dev`'s hot-reload watcher must refresh the
 * AdminApi manifest, not just the runtime modules and HTTP routes.
 *
 * The bug: the watcher's onTrigger called `runtime.setModules(...)` and
 * `server.setRoutes(...)` but never `adminApi.setSchema(...)`, so
 * `GET /_admin/functions` (and the dashboard Functions dropdown built on it) kept
 * serving the boot-time function list until the process was restarted — even though
 * newly saved functions were already live and callable.
 *
 * This test runs the REAL `helipod dev` entrypoint as a child process (the in-process
 * `startDevServer` harness other e2es use would bypass the watcher closure where the
 * bug lives): boot on a copied fixture app, read `/_admin/functions`, save a new
 * function into the watched dir, wait for the watcher's "↻ pushed" line, and assert
 * the admin listing now contains the new function.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "../dist/bin.js");
const FIXTURE = resolve(__dirname, "fixtures/conventional-app");
const ADMIN_KEY = "dev-reload-e2e-admin-key";

let root: string;
let child: ChildProcess;
let out = "";
let baseUrl = "";

function waitForOutput(pattern: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = () => {
      const m = out.match(pattern);
      if (m) return resolvePromise(m);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${pattern}; output so far:\n${out}`));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function adminFunctions(): Promise<string[]> {
  const res = await fetch(`${baseUrl}/_admin/functions`, {
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { functions?: Array<{ path: string }> } | Array<{ path: string }>;
  const list = Array.isArray(body) ? body : (body.functions ?? []);
  return list.map((f) => f.path);
}

beforeAll(async () => {
  // Inside the repo so the copied app resolves bare @helipod/* imports via the
  // repository's own node_modules (a /tmp copy would have no resolution chain).
  root = mkdtempSync(join(__dirname, ".tmp-dev-reload-"));
  cpSync(FIXTURE, root, { recursive: true });

  child = spawn("bun", [BIN, "dev", "--dir", join(root, "helipod"), "--data", join(root, "db.sqlite"), "--port", "0"], {
    cwd: root,
    env: { ...process.env, HELIPOD_ADMIN_KEY: ADMIN_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (out += String(d)));
  child.stderr!.on("data", (d) => (out += String(d)));

  const m = await waitForOutput(/helipod dev → (http:\/\/[^\s]+)/);
  if (!m[1]) throw new Error(`could not parse dev server url from: ${m[0]}`);
  baseUrl = m[1];
}, 60_000);

afterAll(async () => {
  child?.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 200));
  rmSync(root, { recursive: true, force: true });
});

describe("dev hot-reload refreshes the admin function manifest (issue #1)", () => {
  it("a function added while dev is running appears in /_admin/functions without a restart", async () => {
    const before = await adminFunctions();
    expect(before.some((p) => p.includes("notes"))).toBe(true);
    expect(before).not.toContain("ping:pong");

    // Save a brand-new module into the watched functions dir.
    writeFileSync(
      join(root, "helipod", "ping.ts"),
      `import { query } from "./_generated/server";\n` +
        `import { v } from "@helipod/values";\n` +
        `export const pong = query({ args: {}, returns: v.string(), handler: () => "pong" });\n`,
    );

    // The watcher reloads and logs its push.
    await waitForOutput(/↻ pushed/);

    // The new function must be live (this always worked)...
    const run = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "ping:pong", args: {} }),
    });
    expect(run.status).toBe(200);
    expect(((await run.json()) as { value: string }).value).toBe("pong");

    // ...and the admin manifest must have been refreshed too (the bug: it wasn't).
    const after = await adminFunctions();
    expect(after).toContain("ping:pong");
  });
});
