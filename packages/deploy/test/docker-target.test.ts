import { describe, it, expect } from "vitest";
import { dockerTarget } from "../src/targets/docker";
import { DeployError, type DeployContext } from "../src/types";
import { FakeSpawner } from "./support/fake-spawner";

function ctx(spawn: FakeSpawner, over: Partial<DeployContext> = {}): DeployContext {
  return {
    cwd: "/proj", convexDir: "/proj/convex", env: "production",
    target: { targetName: "docker", provider: "docker", env: "production", settings: {} },
    interactive: true, spawn, log: () => {},
    packageApp: async () => ({ files: [] }), codegen: async () => {},
    ...over,
  };
}

describe("dockerTarget", () => {
  it("preflight fails fast when docker is not installed", async () => {
    const spawn = new FakeSpawner(); spawn.missing.add("docker");
    await expect(dockerTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when the docker daemon is not running", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "Cannot connect to the Docker daemon" });
    await expect(dockerTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("push runs `docker compose up -d --build` in the project dir", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0 }); // compose up
    const result = await dockerTarget.push(ctx(spawn));
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({ cmd: "docker", args: ["compose", "up", "-d", "--build"] });
    expect(spawn.calls.at(-1)!.opts).toMatchObject({ cwd: "/proj" });
  });

  it("push reports a compose failure", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "no such file docker-compose.yml" });
    const result = await dockerTarget.push(ctx(spawn));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("docker-compose.yml");
  });
});
