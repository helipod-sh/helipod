import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareTarget } from "../src/targets/cloudflare";
import { DeployError, type DeployContext } from "../src/types";
import { FakeSpawner } from "./support/fake-spawner";

function makeProject(wrangler?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-cf-"));
  if (wrangler !== undefined) writeFileSync(join(dir, "wrangler.jsonc"), wrangler);
  return dir;
}

function ctx(dir: string, spawn: FakeSpawner, over: Partial<DeployContext> = {}): DeployContext {
  return {
    cwd: dir, convexDir: join(dir, "convex"), env: "production",
    target: { targetName: "cloudflare", provider: "cloudflare", env: "production", settings: {} },
    interactive: true, spawn, log: () => {},
    packageApp: async () => ({ files: [] }), codegen: async () => {},
    ...over,
  };
}

describe("cloudflareTarget", () => {
  const cleanup: string[] = [];
  afterEach(() => { cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })); cleanup.length = 0; delete process.env.CLOUDFLARE_API_TOKEN; });

  it("preflight fails fast when wrangler is not installed", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.missing.add("wrangler");
    await expect(cloudflareTarget.preflight(ctx(dir, spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when wrangler.jsonc is absent", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "wrangler 3.0.0" });
    await expect(cloudflareTarget.preflight(ctx(dir, spawn))).rejects.toThrow(/wrangler\.jsonc/);
  });

  it("preflight fails in non-interactive mode without CLOUDFLARE_API_TOKEN, reading no stdin", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "wrangler 3.0.0" });
    await expect(cloudflareTarget.preflight(ctx(dir, spawn, { interactive: false }))).rejects.toBeInstanceOf(DeployError);
  });

  it("package reconciles wrangler.jsonc additively (adds DO binding, keeps user fields)", async () => {
    const dir = makeProject(`{ "name": "app", "main": "w.ts", "vars": { "K": "v" } }`); cleanup.push(dir);
    const spawn = new FakeSpawner();
    let codegenRan = false;
    await cloudflareTarget.package(ctx(dir, spawn, { codegen: async () => { codegenRan = true; } }));
    expect(codegenRan).toBe(true);
    const written = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    const parsed = JSON.parse(written);
    expect(parsed.durable_objects.bindings[0]).toEqual({ name: "STACKBASE_DO", class_name: "StackbaseDO" });
    expect(parsed.vars).toEqual({ K: "v" });
  });

  it("push shells `wrangler deploy` with --env from wranglerEnv and returns the deployed URL", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner();
    spawn.queue({ stdout: "Deployed app triggers\n  https://app.workers.dev\n" });
    const c = ctx(dir, spawn, { target: { targetName: "cf", provider: "cloudflare", env: "staging", settings: { wranglerEnv: "staging" } } });
    const result = await cloudflareTarget.push(c);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://app.workers.dev");
    expect(spawn.calls.at(-1)).toMatchObject({ cmd: "wrangler", args: ["deploy", "--env", "staging"] });
  });

  it("push reports a wrangler failure", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "auth error" });
    const result = await cloudflareTarget.push(ctx(dir, spawn));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("auth error");
  });
});
