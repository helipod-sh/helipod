import { describe, it, expect, afterEach } from "vitest";
import { flyTarget } from "../src/targets/fly";
import { DeployError, type DeployContext } from "../src/types";
import { FakeSpawner } from "./support/fake-spawner";

function ctx(spawn: FakeSpawner, over: Partial<DeployContext> = {}): DeployContext {
  return {
    cwd: "/proj", functionsDir: "/proj/stackbase", env: "production",
    target: { targetName: "fly", provider: "fly", env: "production", settings: {} },
    interactive: true, spawn, log: () => {},
    packageApp: async () => ({ files: [] }), codegen: async () => {},
    ...over,
  };
}

describe("flyTarget", () => {
  afterEach(() => { delete process.env.FLY_API_TOKEN; });

  it("preflight fails fast when the fly CLI is not installed", async () => {
    const spawn = new FakeSpawner(); spawn.missing.add("fly");
    await expect(flyTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when `fly version` exits non-zero", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "broken" });
    await expect(flyTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails in non-interactive mode without FLY_API_TOKEN, reading no stdin", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "flyctl v0.3.0" });
    await expect(flyTarget.preflight(ctx(spawn, { interactive: false }))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight succeeds in non-interactive mode when FLY_API_TOKEN is set", async () => {
    process.env.FLY_API_TOKEN = "tok";
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "flyctl v0.3.0" });
    await expect(flyTarget.preflight(ctx(spawn, { interactive: false }))).resolves.toBeUndefined();
  });

  it("preflight succeeds interactively without FLY_API_TOKEN", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "flyctl v0.3.0" });
    await expect(flyTarget.preflight(ctx(spawn))).resolves.toBeUndefined();
  });

  it("package runs codegen", async () => {
    const spawn = new FakeSpawner();
    let codegenRan = false;
    await flyTarget.package(ctx(spawn, { codegen: async () => { codegenRan = true; } }));
    expect(codegenRan).toBe(true);
  });

  it("push shells `fly deploy` in the project dir", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0, stdout: "==> Verifying app config\ndeployed successfully\n" });
    const result = await flyTarget.push(ctx(spawn));
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({ cmd: "fly", args: ["deploy"] });
    expect(spawn.calls.at(-1)!.opts).toMatchObject({ cwd: "/proj" });
  });

  it("push passes --app and --region when configured", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0 });
    const c = ctx(spawn, {
      target: { targetName: "fly", provider: "fly", env: "staging", settings: { app: "my-app", region: "iad" } },
    });
    const result = await flyTarget.push(c);
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({
      cmd: "fly",
      args: ["deploy", "--app", "my-app", "--region", "iad"],
    });
  });

  it("push reports a non-zero failure", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "deploy failed: build error" });
    const result = await flyTarget.push(ctx(spawn));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("build error");
  });
});
