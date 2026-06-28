/**
 * `serve`, `deploy`, `build`, `objectstore`, and `codegen` all resolve their functions directory
 * through the shared `resolveFunctionsDir` (Task 1) instead of a bare `convex` default — this file
 * proves each command fails loudly (exit 1, the migrate hint) when that directory doesn't exist,
 * rather than silently defaulting to `convex/` or crashing with a raw fs error.
 *
 * `serveCommand([])` + `process.chdir` (as sketched in the plan) is deliberately NOT used here:
 * this suite's tests share a vitest worker process, and mutating `process.cwd()` for one test can
 * leak into concurrently-running tests. Passing an explicit `--dir <nonexistent-path>` exercises
 * the exact same failure branch (`resolveFunctionsDir` treats a given flag value as authoritative,
 * skips config-file lookup, and the subsequent `existsSync` check fails) without touching global
 * process state.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCommand } from "../src/serve";
import { deployCommand } from "../src/deploy";
import { buildCommand } from "../src/build";
import { codegenCommand } from "../src/cli";

function missingDir(): string {
  // A fresh scratch dir that is never populated with a `<missing>` subdirectory — the path itself
  // is guaranteed not to exist on disk.
  return join(mkdtempSync(join(tmpdir(), "sb-missing-")), "nonexistent-functions-dir");
}

describe("commands fail loudly on a missing functions directory", () => {
  it("serve reports the missing directory and the migrate hint", async () => {
    const dir = missingDir();
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string): boolean => { errors.push(String(chunk)); return true; };
    const prevKey = process.env.STACKBASE_ADMIN_KEY;
    process.env.STACKBASE_ADMIN_KEY = "test-key";
    try {
      const code = await serveCommand(["--dir", dir]);
      expect(code).toBe(1);
    } finally {
      if (prevKey === undefined) delete process.env.STACKBASE_ADMIN_KEY;
      else process.env.STACKBASE_ADMIN_KEY = prevKey;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    const all = errors.join("");
    expect(all).toContain(dir);
    expect(all).toContain("stackbase migrate");
  });

  it("codegen reports the missing directory and the migrate hint", async () => {
    const dir = missingDir();
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string): boolean => { errors.push(String(chunk)); return true; };
    try {
      const code = await codegenCommand(["--dir", dir]);
      expect(code).toBe(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    const all = errors.join("");
    expect(all).toContain(dir);
    expect(all).toContain("stackbase migrate");
  });

  it("build reports a clean failure rather than a raw fs crash", async () => {
    const dir = missingDir();
    await expect(buildCommand(["--dir", dir])).rejects.toThrow();
  });

  it("deploy's --check drift check reports a clean failure rather than a raw fs crash", async () => {
    const dir = missingDir();
    await expect(
      deployCommand(["--dir", dir, "--check"], { cwd: process.cwd(), interactive: false }),
    ).rejects.toThrow();
  });
});
