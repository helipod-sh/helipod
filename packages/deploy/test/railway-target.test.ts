import { describe, it, expect, afterEach } from "vitest";
import { railwayTarget } from "../src/targets/railway";
import { DeployError, type DeployContext } from "../src/types";
import { FakeSpawner } from "./support/fake-spawner";

function ctx(spawn: FakeSpawner, over: Partial<DeployContext> = {}): DeployContext {
  return {
    cwd: "/proj", convexDir: "/proj/convex", env: "production",
    target: { targetName: "railway", provider: "railway", env: "production", settings: {} },
    interactive: true, spawn, log: () => {},
    packageApp: async () => ({ files: [] }), codegen: async () => {},
    ...over,
  };
}

describe("railwayTarget", () => {
  afterEach(() => { delete process.env.RAILWAY_TOKEN; });

  it("preflight fails fast when the railway CLI is not installed", async () => {
    const spawn = new FakeSpawner(); spawn.missing.add("railway");
    await expect(railwayTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when `railway --version` exits non-zero", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "broken" });
    await expect(railwayTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails in non-interactive mode without RAILWAY_TOKEN, reading no stdin", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "railway 3.0.0" });
    await expect(railwayTarget.preflight(ctx(spawn, { interactive: false }))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight succeeds in non-interactive mode when RAILWAY_TOKEN is set", async () => {
    process.env.RAILWAY_TOKEN = "tok";
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "railway 3.0.0" });
    await expect(railwayTarget.preflight(ctx(spawn, { interactive: false }))).resolves.toBeUndefined();
  });

  it("preflight succeeds interactively without RAILWAY_TOKEN", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "railway 3.0.0" });
    await expect(railwayTarget.preflight(ctx(spawn))).resolves.toBeUndefined();
  });

  it("package runs codegen", async () => {
    const spawn = new FakeSpawner();
    let codegenRan = false;
    await railwayTarget.package(ctx(spawn, { codegen: async () => { codegenRan = true; } }));
    expect(codegenRan).toBe(true);
  });

  it("push shells `railway up` in the project dir", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0, stdout: "Build Logs: https://railway.app/project/x\n" });
    const result = await railwayTarget.push(ctx(spawn));
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({ cmd: "railway", args: ["up"] });
    expect(spawn.calls.at(-1)!.opts).toMatchObject({ cwd: "/proj" });
  });

  it("push passes --service and --environment when configured", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0 });
    const c = ctx(spawn, {
      target: { targetName: "railway", provider: "railway", env: "staging", settings: { service: "api", environment: "staging" } },
    });
    const result = await railwayTarget.push(c);
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({
      cmd: "railway",
      args: ["up", "--service", "api", "--environment", "staging"],
    });
  });

  it("push reports a non-zero failure", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "deploy failed: build error" });
    const result = await railwayTarget.push(ctx(spawn));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("build error");
  });
});
