/**
 * `serve`, `deploy`, `build`, `objectstore`, and `codegen` all resolve their functions directory
 * through the shared `resolveFunctionsDir` (Task 1) instead of a bare `convex` default — this file
 * proves each command fails loudly (exit 1, the migrate hint) when that directory doesn't exist,
 * rather than silently defaulting to `convex/` or crashing with a raw fs error or an unhandled
 * rejection. All five now route the check through the shared `ensureFunctionsDirExists` helper
 * (`../src/functions-dir.ts`), so every assertion below is the same shape: exit code 1, and stderr
 * containing both the missing path and the `helipod migrate` hint.
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
import { objectstoreCommand } from "../src/objectstore";
import { codegenCommand } from "../src/cli";

function missingDir(): string {
  // A fresh scratch dir that is never populated with a `<missing>` subdirectory — the path itself
  // is guaranteed not to exist on disk.
  return join(mkdtempSync(join(tmpdir(), "sb-missing-")), "nonexistent-functions-dir");
}

/** Run `fn` while capturing everything written to stderr, restoring the real stream afterward. */
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string): boolean => { chunks.push(String(chunk)); return true; };
  try {
    const code = await fn();
    return { code, err: chunks.join("") };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = original;
  }
}

describe("commands fail loudly on a missing functions directory", () => {
  it("serve reports the missing directory and the migrate hint", async () => {
    const dir = missingDir();
    const prevKey = process.env.HELIPOD_ADMIN_KEY;
    process.env.HELIPOD_ADMIN_KEY = "test-key";
    let result: { code: number; err: string };
    try {
      result = await captureStderr(() => serveCommand(["--dir", dir]));
    } finally {
      if (prevKey === undefined) delete process.env.HELIPOD_ADMIN_KEY;
      else process.env.HELIPOD_ADMIN_KEY = prevKey;
    }
    expect(result.code).toBe(1);
    expect(result.err).toContain(dir);
    expect(result.err).toContain("helipod migrate");
  });

  it("codegen reports the missing directory and the migrate hint", async () => {
    const dir = missingDir();
    const { code, err } = await captureStderr(() => codegenCommand(["--dir", dir]));
    expect(code).toBe(1);
    expect(err).toContain(dir);
    expect(err).toContain("helipod migrate");
  });

  it("build reports the missing directory and the migrate hint (not a raw fs crash)", async () => {
    const dir = missingDir();
    const { code, err } = await captureStderr(() => buildCommand(["--dir", dir]));
    expect(code).toBe(1);
    expect(err).toContain(dir);
    expect(err).toContain("helipod migrate");
  });

  it("deploy's --check drift check reports the missing directory and the migrate hint (not a raw fs crash)", async () => {
    const dir = missingDir();
    const { code, err } = await captureStderr(() =>
      deployCommand(["--dir", dir, "--check"], { cwd: process.cwd(), interactive: false }),
    );
    expect(code).toBe(1);
    expect(err).toContain(dir);
    expect(err).toContain("helipod migrate");
  });

  it("objectstore reshard reports the missing directory and the migrate hint (not a raw fs crash)", async () => {
    const dir = missingDir();
    const { code, err } = await captureStderr(() =>
      objectstoreCommand(["reshard", "--object-store", `file://${dir}-store`, "--shards", "1", "--dir", dir]),
    );
    expect(code).toBe(1);
    expect(err).toContain(dir);
    expect(err).toContain("helipod migrate");
  });
});
