import type { Spawner, SpawnOptions, SpawnResult } from "../../src/types";

export class FakeSpawner implements Spawner {
  calls: Array<{ cmd: string; args: string[]; opts?: SpawnOptions }> = [];
  private results: SpawnResult[] = [];
  /** Fail with ENOENT-style rejection for the next matching cmd (simulates "CLI not installed"). */
  missing = new Set<string>();

  queue(result: Partial<SpawnResult>): void {
    this.results.push({ code: 0, stdout: "", stderr: "", ...result });
  }

  async run(cmd: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult> {
    this.calls.push({ cmd, args, opts });
    if (this.missing.has(cmd)) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
    return this.results.shift() ?? { code: 0, stdout: "", stderr: "" };
  }
}
