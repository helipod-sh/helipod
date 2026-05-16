import { describe, it, expect } from "vitest";
import { NodeSpawner } from "../src/spawner";
import { FakeSpawner } from "./support/fake-spawner";

describe("NodeSpawner", () => {
  it("captures stdout and exit code of a real subprocess", async () => {
    const s = new NodeSpawner();
    const r = await s.run(process.execPath, ["-e", "process.stdout.write('hi')"], { stdio: "capture" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi");
  });

  it("reports a non-zero exit code", async () => {
    const s = new NodeSpawner();
    const r = await s.run(process.execPath, ["-e", "process.exit(3)"], { stdio: "capture" });
    expect(r.code).toBe(3);
  });
});

describe("FakeSpawner", () => {
  it("records calls and returns queued results FIFO", async () => {
    const s = new FakeSpawner();
    s.queue({ stdout: "wrangler 3.0.0" });
    const r = await s.run("wrangler", ["--version"], { stdio: "capture" });
    expect(r.stdout).toBe("wrangler 3.0.0");
    expect(s.calls).toMatchObject([{ cmd: "wrangler", args: ["--version"] }]);
  });
});
