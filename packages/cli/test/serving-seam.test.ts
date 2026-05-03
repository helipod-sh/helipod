/**
 * Task 5 (Slice 1) — proves the caller no longer owns the serving primitives. After the RuntimeHost
 * seam, `Bun.serve` / `node:http` `createServer` / the `ws` package live ONLY inside the process-host
 * impl (`server.ts`); `cli.ts` (dev) and `serve.ts` (serve) reach serving exclusively through
 * `new ProcessRuntimeHost().serve(...)`. Source-scan over COMMENT-STRIPPED code (the doc-comments
 * mention these primitives by name to explain the seam — that prose must not trip the gate).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dirname, "../src");

/** Drop block (`/* … *\/`) and line (`// …`) comments so scans see only code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `.ts` file in `packages/cli/src`, mapped to its comment-stripped code. */
function srcCode(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(srcDir)) {
    if (name.endsWith(".ts")) out.set(name, stripComments(readFileSync(join(srcDir, name), "utf8")));
  }
  return out;
}

// The host-serving primitives, as they appear in CODE. `.serve(` alone is NOT a marker — that is the
// seam call in cli.ts/serve.ts — so we match the runtime-owned forms specifically. `Bun.serve`
// (capital) never appears today (the impl abstracts it behind `bun.serve(`); it stays here so a
// future regression that writes `Bun.serve` directly in a caller is still caught elsewhere.
const SERVING = [/from\s+["']node:http["']/, /\bBun\.serve\b/, /\bbun\.serve\(/, /\bWebSocketServer\b/, /\bimport\(["']ws["']\)/];
// The subset genuinely present in server.ts today — used to prove the test isn't vacuous.
const PRESENT_IN_SERVER = [/from\s+["']node:http["']/, /\bbun\.serve\(/, /\bWebSocketServer\b/, /\bimport\(["']ws["']\)/];

describe("serving primitives are owned only by the process host (server.ts)", () => {
  const code = srcCode();

  it("server.ts actually contains the serving primitives (test is not vacuous)", () => {
    const server = code.get("server.ts")!;
    expect(server).toBeDefined();
    for (const pat of PRESENT_IN_SERVER) expect(pat.test(server), `server.ts should own ${pat}`).toBe(true);
  });

  it("no cli/src file other than server.ts references a serving primitive", () => {
    for (const [name, text] of code) {
      if (name === "server.ts") continue;
      for (const pat of SERVING) {
        expect(pat.test(text), `${name} must not reference serving primitive ${pat}`).toBe(false);
      }
    }
  });

  it("cli.ts and serve.ts reach serving through the RuntimeHost seam", () => {
    for (const name of ["cli.ts", "serve.ts"]) {
      const text = code.get(name)!;
      expect(text.includes("new ProcessRuntimeHost()"), `${name} must construct ProcessRuntimeHost`).toBe(true);
      expect(/\.serve\(/.test(text), `${name} must call host.serve(...)`).toBe(true);
    }
  });
});
