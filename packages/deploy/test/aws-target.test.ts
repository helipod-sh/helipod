import { describe, it, expect, afterEach } from "vitest";
import { awsTarget } from "../src/targets/aws";
import { DeployError, type DeployContext } from "../src/types";
import { FakeSpawner } from "./support/fake-spawner";

function ctx(spawn: FakeSpawner, over: Partial<DeployContext> = {}): DeployContext {
  return {
    cwd: "/proj", functionsDir: "/proj/helipod", env: "production",
    target: {
      targetName: "aws", provider: "aws", env: "production",
      settings: { serviceArn: "arn:aws:apprunner:us-east-1:123456789012:service/my-app/abc123" },
    },
    interactive: true, spawn, log: () => {},
    packageApp: async () => ({ files: [] }), codegen: async () => {},
    ...over,
  };
}

describe("awsTarget", () => {
  afterEach(() => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;
  });

  it("preflight fails fast when the aws CLI is not installed", async () => {
    const spawn = new FakeSpawner(); spawn.missing.add("aws");
    await expect(awsTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when `aws --version` exits non-zero", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "broken" });
    await expect(awsTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when serviceArn is not configured", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "aws-cli/2.15.0" });
    const c = ctx(spawn, { target: { targetName: "aws", provider: "aws", env: "production", settings: {} } });
    await expect(awsTarget.preflight(c)).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails in non-interactive mode without AWS credentials, reading no stdin", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "aws-cli/2.15.0" });
    await expect(awsTarget.preflight(ctx(spawn, { interactive: false }))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight succeeds in non-interactive mode when AWS_ACCESS_KEY_ID is set", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "aws-cli/2.15.0" });
    await expect(awsTarget.preflight(ctx(spawn, { interactive: false }))).resolves.toBeUndefined();
  });

  it("preflight succeeds in non-interactive mode when AWS_PROFILE is set", async () => {
    process.env.AWS_PROFILE = "prod";
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "aws-cli/2.15.0" });
    await expect(awsTarget.preflight(ctx(spawn, { interactive: false }))).resolves.toBeUndefined();
  });

  it("preflight succeeds interactively without AWS credentials set", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "aws-cli/2.15.0" });
    await expect(awsTarget.preflight(ctx(spawn))).resolves.toBeUndefined();
  });

  it("package runs codegen", async () => {
    const spawn = new FakeSpawner();
    let codegenRan = false;
    await awsTarget.package(ctx(spawn, { codegen: async () => { codegenRan = true; } }));
    expect(codegenRan).toBe(true);
  });

  it("push shells `aws apprunner start-deployment` with the configured service ARN", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0, stdout: '{"OperationId": "abc-123"}' });
    const result = await awsTarget.push(ctx(spawn));
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({
      cmd: "aws",
      args: ["apprunner", "start-deployment", "--service-arn", "arn:aws:apprunner:us-east-1:123456789012:service/my-app/abc123"],
    });
    expect(spawn.calls.at(-1)!.opts).toMatchObject({ cwd: "/proj" });
  });

  it("push passes --region when configured", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0 });
    const c = ctx(spawn, {
      target: { targetName: "aws", provider: "aws", env: "production", settings: { serviceArn: "arn:x", region: "us-west-2" } },
    });
    const result = await awsTarget.push(c);
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({
      cmd: "aws",
      args: ["apprunner", "start-deployment", "--service-arn", "arn:x", "--region", "us-west-2"],
    });
  });

  it("push reports a non-zero failure", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "ServiceNotFoundException" });
    const result = await awsTarget.push(ctx(spawn));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ServiceNotFoundException");
  });
});
