/**
 * Task 4 (Slice 1) — the CRITICAL neutrality gate for the `RuntimeHost` seam. `src/host.ts` is the
 * one neutral boundary a Durable Object host (Slice 3) must implement WITHOUT dragging in a process
 * primitive; if a host I/O import ever leaks into it, the seam stops being neutral. Source-scan
 * assertions (same style as `packages/cli/test/docker-config.test.ts`) keep it honest:
 *   1. every import in `host.ts` is either `@helipod/*` or type-only, and none names a forbidden
 *      host primitive (`bun`, `node:*`, `ws`, cloudflare, `DurableObject`);
 *   2. the DO namespace type appears nowhere under `packages/` or `components/` (roadmap gate).
 *
 * Scans are run over COMMENT-STRIPPED source: the checks target real code (imports, type
 * references), not the prose in doc-comments — this very seam is DOCUMENTED in terms of the tokens
 * it forbids in code, and that documentation must not trip its own gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOST_PATH = join(import.meta.dirname, "../src/host.ts");
const SELF_PATH = join(import.meta.dirname, "host-neutral.test.ts"); // this file names the token in code
const hostSrc = readFileSync(HOST_PATH, "utf8");
const repoRoot = join(import.meta.dirname, "../../.."); // repo root from packages/runtime-embedded/test

/** Drop block (`/* … *\/`) and line (`// …`) comments so scans see only code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `import ... from "<spec>"` / `export ... from "<spec>"` statement, with its type-only flag. */
function importStatements(src: string): Array<{ typeOnly: boolean; spec: string }> {
  const out: Array<{ typeOnly: boolean; spec: string }> = [];
  const re = /(?:^|\n)\s*(?:import|export)(\s+type)?\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ typeOnly: Boolean(m[1]), spec: m[2]! });
  return out;
}

// Forbidden host primitives, as they would appear in CODE: import specifiers for bun/node:/ws, and
// bare type/identifier references for cloudflare/DurableObject (globals from @cloudflare types).
const FORBIDDEN = [/\bfrom\s+["']bun["']/, /\bfrom\s+["']node:/, /\bfrom\s+["']ws["']/, /cloudflare/i, /DurableObject/];

describe("host.ts is import-neutral (RuntimeHost seam)", () => {
  const hostCode = stripComments(hostSrc);

  it("imports only @helipod/* or type-only specifiers", () => {
    const imports = importStatements(hostCode);
    expect(imports.length).toBeGreaterThan(0); // sanity: the regex actually matched
    for (const { typeOnly, spec } of imports) {
      const neutral = typeOnly || spec.startsWith("@helipod/");
      expect(neutral, `non-neutral import in host.ts: "${spec}" (type-only=${typeOnly})`).toBe(true);
    }
  });

  it("names no host I/O primitive (bun / node: / ws / cloudflare / DurableObject) in code", () => {
    for (const pat of FORBIDDEN) {
      expect(pat.test(hostCode), `host.ts must not reference ${pat} in code`).toBe(false);
    }
  });

  it("no DurableObjectNamespace type anywhere under packages/ or components/ (except the DO host)", () => {
    // The Cloudflare DO host (Slice 3) is the ONE package allowed to name the DO namespace — that is
    // the whole point of isolating Cloudflare in a leaf host package. The gate is that it leaks
    // NOWHERE ELSE (the engine, every other package, every component).
    const HOST_PKG = join(repoRoot, "packages", "runtime-cloudflare");
    const offenders: string[] = [];
    for (const dir of ["packages", "components"]) {
      scanTs(join(repoRoot, dir), (file, text) => {
        if (file === SELF_PATH) return; // this test necessarily names the token it searches for
        if (file.startsWith(HOST_PKG)) return; // the DO host + rig legitimately name it
        if (stripComments(text).includes("DurableObjectNamespace")) offenders.push(file);
      });
    }
    expect(offenders, `DurableObjectNamespace found in: ${offenders.join(", ")}`).toEqual([]);
  });
});

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "coverage", ".helipod-deploy"]);

/** Recursively read every `.ts`/`.tsx` source file under `root`, skipping build/vendor dirs. */
function scanTs(root: string, visit: (file: string, text: string) => void): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // dir may not exist (e.g. an empty `components/`)
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) scanTs(full, visit);
    } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
      visit(full, readFileSync(full, "utf8"));
    }
  }
}
