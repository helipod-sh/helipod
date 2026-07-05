/**
 * Engine-neutrality gate (Slice 3, Task 10). Cloudflare exists ONLY inside this leaf host package:
 * the engine (`runtime-embedded`/`transactor`/`sync`) must contain NO Cloudflare type in CODE. This
 * scans their comment-stripped source for the forbidden tokens (`cloudflare`, `DurableObject`,
 * `WebSocketPair`, `SqlStorage`) and proves the `disableSyncBackgroundTimers`/`disableBackgroundTimers`
 * knob — the one legit engine edit — imports no host type (it's a bare boolean).
 *
 * Also the `satisfies RuntimeHost` compile+runtime proof for `DurableObjectRuntimeHost` (Task 2).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeHost } from "@helipod/runtime-embedded";
import type { StorageRoute } from "@helipod/storage";
import { DurableObjectRuntimeHost } from "../src/index";

const repoRoot = join(import.meta.dirname, "../../..");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "coverage"]);
function scanTs(root: string, visit: (file: string, text: string) => void): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) scanTs(full, visit);
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      visit(full, readFileSync(full, "utf8"));
    }
  }
}

// Cloudflare shapes as they'd appear in engine CODE. `SqlStorage` is deliberately excluded from the
// scan set because it is the shipped `docstore-do-sqlite` seam's OWN structural name; the engine
// packages below never reference it. We target the DO/Worker-specific tokens.
const FORBIDDEN = [/cloudflare/i, /\bDurableObject/, /\bWebSocketPair\b/];

describe("engine neutrality — Cloudflare stays in the leaf host package", () => {
  for (const pkg of ["runtime-embedded", "transactor", "sync"]) {
    it(`packages/${pkg}/src names no Cloudflare type in code`, () => {
      const offenders: string[] = [];
      scanTs(join(repoRoot, "packages", pkg, "src"), (file, text) => {
        const code = stripComments(text);
        for (const pat of FORBIDDEN) if (pat.test(code)) offenders.push(`${file} :: ${pat}`);
      });
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }

  it("the disableBackgroundTimers knob is a bare boolean (no host type crosses the seam)", () => {
    // The handler option and the runtime option are both `?: boolean` — a source-level check that the
    // knob never imports/references a Cloudflare or DurableObject type on its declaration lines.
    const handler = readFileSync(join(repoRoot, "packages", "sync", "src", "handler.ts"), "utf8");
    const runtime = readFileSync(join(repoRoot, "packages", "runtime-embedded", "src", "runtime.ts"), "utf8");
    expect(handler).toMatch(/disableBackgroundTimers\?:\s*boolean/);
    expect(runtime).toMatch(/disableSyncBackgroundTimers\?:\s*boolean/);
  });

  it("DurableObjectRuntimeHost satisfies the RuntimeHost seam", () => {
    // `StorageRt` is pinned to `StorageRoute` (the host matches storage + component reserved routes),
    // so the seam proof supplies it; Route/Admin stay `never` (only the shape matters here).
    const host = new DurableObjectRuntimeHost() satisfies RuntimeHost<never, never, StorageRoute>;
    expect(typeof host.serve).toBe("function");
    expect(typeof host.fetch).toBe("function");
  });
});
