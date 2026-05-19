import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployCommand } from "../src/deploy";
import type { Spawner } from "@stackbase/deploy";

/** A project dir with a minimal convex/ and a stackbase.config.js selecting the cloudflare target. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-dispatch-"));
  mkdirSync(join(dir, "convex"), { recursive: true });
  writeFileSync(join(dir, "convex", "schema.ts"), `import { defineSchema } from "@stackbase/values";\nexport default defineSchema({});\n`);
  writeFileSync(join(dir, "wrangler.jsonc"), `{ "name": "app", "main": "w.ts" }`);
  writeFileSync(
    join(dir, "stackbase.config.js"),
    `export default { components: [], deploy: { defaultTarget: "cloudflare", targets: { cloudflare: { provider: "cloudflare" } } } };`,
  );
  return dir;
}

class RecordingSpawner implements Spawner {
  calls: Array<{ cmd: string; args: string[] }> = [];
  async run(cmd: string, args: string[]) {
    this.calls.push({ cmd, args });
    if (args[0] === "--version") return { code: 0, stdout: "wrangler 3.0.0", stderr: "" };
    if (args[0] === "deploy") return { code: 0, stdout: "https://app.workers.dev", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("deployCommand dispatch", () => {
  const cleanup: string[] = [];
  afterEach(() => { cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })); cleanup.length = 0; });

  it("--dry-run runs preflight+package but never calls `wrangler deploy`", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const spawn = new RecordingSpawner();
    const code = await deployCommand(["--dry-run"], { spawn, cwd: dir, interactive: true });
    expect(code).toBe(0);
    expect(spawn.calls.some((c) => c.args[0] === "--version")).toBe(true); // preflight ran
    expect(spawn.calls.some((c) => c.args[0] === "deploy")).toBe(false);   // push skipped
  });

  it("a full deploy shells `wrangler deploy`", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const spawn = new RecordingSpawner();
    const code = await deployCommand([], { spawn, cwd: dir, interactive: true });
    expect(code).toBe(0);
    expect(spawn.calls.some((c) => c.args[0] === "deploy")).toBe(true);
  });

  it("returns exit code 1 with a clear message on an unknown target", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const code = await deployCommand(["--target", "ghost"], { spawn: new RecordingSpawner(), cwd: dir, interactive: true });
    expect(code).toBe(1);
  });
});
