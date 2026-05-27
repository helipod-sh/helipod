import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startBackend, installSignalCleanup, type SpawnedChild } from "../src/child";

/** A fake child process: EventEmitter for "exit", PassThrough stdout/stderr, a kill() spy. */
function fakeChild(): SpawnedChild & EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const child = Object.assign(ee, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  return child as never;
}

describe("startBackend", () => {
  it("resolves once the probe reports ready, and pipes log lines", async () => {
    const child = fakeChild();
    const logs: string[] = [];
    let calls = 0;
    const probe = vi.fn(async () => ++calls >= 2); // ready on the 2nd poll
    const backend = await startBackend(
      { command: "x", args: ["dev"], cwd: "/tmp", port: 9999, pollIntervalMs: 1, onLog: (l) => logs.push(l) },
      { spawn: () => child, probe },
    );
    (child.stdout as PassThrough).write("hello\nworld\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(logs).toContain("hello");
    expect(logs).toContain("world");
    expect(probe).toHaveBeenCalled();
    backend.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    backend.stop(); // idempotent
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects when the child exits before becoming ready", async () => {
    const child = fakeChild();
    const probe = vi.fn(async () => false);
    const p = startBackend(
      { command: "x", args: ["dev"], cwd: "/tmp", port: 9999, pollIntervalMs: 1 },
      { spawn: () => child, probe },
    );
    setTimeout(() => child.emit("exit", 1), 3);
    await expect(p).rejects.toThrow(/exited before/);
  });

  it("rejects on readiness timeout", async () => {
    const child = fakeChild();
    const probe = vi.fn(async () => false);
    await expect(
      startBackend(
        { command: "x", args: ["dev"], cwd: "/tmp", port: 9999, pollIntervalMs: 1, readinessTimeoutMs: 15 },
        { spawn: () => child, probe },
      ),
    ).rejects.toThrow(/did not become ready/);
  });
});

describe("installSignalCleanup", () => {
  it("calls stop on SIGINT and then exits", () => {
    const proc = new EventEmitter();
    const stop = vi.fn();
    const exit = vi.fn();
    installSignalCleanup(stop, proc as never, exit);
    proc.emit("SIGINT");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });
});
