import { spawn } from "node:child_process";
import type { Spawner, SpawnOptions, SpawnResult } from "./types";

export class NodeSpawner implements Spawner {
  run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
    const capture = opts.stdio === "capture";
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => reject(e)); // e.g. ENOENT when the CLI is not installed
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }
}
