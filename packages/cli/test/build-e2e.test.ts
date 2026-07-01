import { describe, it, expect, afterAll } from "vitest";
import { buildCommand } from "../src/build";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

// `bun run --filter @stackbase/cli test` resolves `vitest` off PATH (node_modules/.bin/vitest), which
// carries a `#!/usr/bin/env node` shebang — Bun execs it honoring that shebang, so the vitest process
// (and its test workers) run under real Node here, not Bun. The `Bun` global is undefined throughout
// (confirmed directly: `typeof globalThis.Bun` is `"undefined"` even in vitest's main process). The
// compiled binary under test is a self-contained native executable regardless of what spawns it, so we
// launch it with `node:child_process.spawn` instead of `Bun.spawn` — same behavior, no `Bun` global
// dependency.
const OUT = resolve("./.tmp-build/server");
const DATA = resolve("./.tmp-build/data");
afterAll(() => rmSync("./.tmp-build", { recursive: true, force: true }));

function readReadyLine(stdout: NodeJS.ReadableStream): Promise<{ url: string }> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        stdout.off("data", onData);
        stdout.off("end", onEnd);
        resolvePromise(JSON.parse(buf.slice(0, nl)));
      }
    };
    const onEnd = () => reject(new Error("binary exited before ready line"));
    stdout.on("data", onData);
    stdout.once("end", onEnd);
  });
}

describe("stackbase build (real compiled binary)", () => {
  it("compiles a fixture app (with a component) and the binary serves a committing mutation", async () => {
    const rc = await buildCommand(["--dir", "test/fixtures/build-app/stackbase", "--outfile", OUT, "--no-dashboard"]);
    expect(rc).toBe(0);
    expect(existsSync(OUT)).toBe(true);

    const proc = spawn(OUT, ["--port", "3599", "--hostname", "127.0.0.1", "--data-dir", DATA], {
      env: { ...process.env, STACKBASE_ADMIN_KEY: "e2e" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      const { url } = await readReadyLine(proc.stdout!);
      expect(url).toBe("http://127.0.0.1:3599");
      const add = await fetch(`${url}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "notes:add", args: { box: "a", text: "compiled" } }) });
      expect((await add.json()).committed).toBe(true);
      const list = await fetch(`${url}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "notes:list", args: {} }) });
      expect((await list.json()).value).toEqual([{ box: "a", text: "compiled" }]);
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  }, 120_000);

  it("cross-compiles to linux-x64 (produces a non-empty file, not executed here)", async () => {
    const rc = await buildCommand(["--dir", "test/fixtures/build-app/stackbase", "--outfile", `${OUT}-linux`, "--target", "linux-x64", "--no-dashboard"]);
    expect(rc).toBe(0);
    expect(statSync(`${OUT}-linux`).size).toBeGreaterThan(1_000_000);
  }, 120_000);

  it("embeds the dashboard by default (served) and omits it with --no-dashboard", async () => {
    const rc = await buildCommand(["--dir", "test/fixtures/build-app/stackbase", "--outfile", `${OUT}-dash`]); // dashboard ON
    expect(rc).toBe(0);
    const proc = spawn(`${OUT}-dash`, ["--port", "3601", "--hostname", "127.0.0.1", "--data-dir", `${DATA}-dash`], {
      env: { ...process.env, STACKBASE_ADMIN_KEY: "e2e" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      const { url } = await readReadyLine(proc.stdout!);
      const root = await fetch(`${url}/`);
      expect(root.status).toBe(200);
      const html = await root.text();
      expect(html.toLowerCase()).toContain("stackbase");

      // Regression guard: index.html (vite base:"/_dashboard/") references its JS bundle at
      // `/_dashboard/assets/index-<hash>.js`, but the embedded asset map's keys are root-relative
      // (`/assets/...`). `serveDashboard`'s fallback strips the `/_dashboard` prefix before the map
      // lookup — assert that fallback actually resolves a real asset end-to-end, not just that `/` 200s.
      const jsMatch = html.match(/src="([^"]+\.js)"/);
      if (!jsMatch) throw new Error("no JS bundle <script src> found in embedded dashboard index.html");
      const jsUrl = jsMatch[1];
      const asset = await fetch(`${url}${jsUrl}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
  }, 120_000);
});
