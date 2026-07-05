import type { ReportEntry } from "./source";

/** Unambiguous specifier → target rewrites (applied wherever the quoted specifier appears). */
const SIMPLE: Record<string, string> = {
  "convex/values": "@helipod/values",
  "convex/react": "@helipod/client/react",
  "convex/browser": "@helipod/client",
};

const SCHEMA_SYMBOLS = new Set(["defineSchema", "defineTable"]);
const SERVER_SYMBOLS = new Set(["httpRouter", "httpAction"]);
const CRON_SYMBOLS = new Set(["cronJobs"]);

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * Rewrite Convex import specifiers to their Helipod equivalents. Operates on the quoted module
 * specifier so `import`, `export … from`, `require()`, and dynamic `import()` are all handled.
 * `convex/server` is symbol-aware; `./_generated/server` is left alone.
 */
export function rewriteImports(source: string, file: string): { output: string; entries: ReportEntry[] } {
  const entries: ReportEntry[] = [];
  let output = source;

  // 1. Unambiguous specifiers — replace every quoted occurrence.
  for (const [from, to] of Object.entries(SIMPLE)) {
    const re = new RegExp(`(["'])${from.replace("/", "\\/")}\\1`, "g");
    const input = output; // the string this pass's match offsets index into
    output = output.replace(re, (_m, q, offset: number) => {
      entries.push({ severity: "auto-fixed", file, line: lineOf(input, offset), what: `import "${from}"`, fix: `rewritten to "${to}"` });
      return `${q}${to}${q}`;
    });
  }

  // 2. convex/server — symbol-aware (brace clause; multi-line brace clauses are handled since
  // `[^}]*` matches across newlines).
  const serverRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])convex\/server\2/g;
  const serverInput = output; // the string this pass's match offsets index into
  output = output.replace(serverRe, (full, names: string, q: string, offset: number) => {
    const line = lineOf(serverInput, offset);
    const syms = names.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    const allSchema = syms.length > 0 && syms.every((s) => SCHEMA_SYMBOLS.has(s));
    const allServer = syms.length > 0 && syms.every((s) => SERVER_SYMBOLS.has(s));
    if (allSchema) {
      entries.push({ severity: "auto-fixed", file, line, what: `import "convex/server" (schema)`, fix: `rewritten to "@helipod/values"` });
      return full.replace(/["']convex\/server["']/, `${q}@helipod/values${q}`);
    }
    if (allServer) {
      entries.push({ severity: "auto-fixed", file, line, what: `import "convex/server" (http)`, fix: `rewritten to "./_generated/server"` });
      return full.replace(/["']convex\/server["']/, `${q}./_generated/server${q}`);
    }
    const hasCron = syms.some((s) => CRON_SYMBOLS.has(s));
    const hasOther = syms.some((s) => !CRON_SYMBOLS.has(s));
    const cronFix = `cronJobs → import from "@helipod/scheduler" and compose defineScheduler() in helipod.config.ts`;
    const genericFix = `defineSchema/defineTable → "@helipod/values"; httpRouter/httpAction → "./_generated/server"`;
    const fix =
      hasCron && hasOther
        ? `${cronFix}; other symbols: map manually: ${genericFix}`
        : hasCron
          ? cronFix
          : `map each symbol manually: ${genericFix}`;
    entries.push({ severity: "action-needed", file, line, what: `import { ${syms.join(", ")} } from "convex/server"`, fix });
    return full; // leave unchanged
  });

  // 3. Any convex/server occurrence NOT matched above (default import, export-from, require,
  // dynamic import). Re-derive step 2's brace-clause match ranges against the FINAL output (not
  // the offsets recorded during step 2, which may no longer line up after earlier rewrites shift
  // string length) so occurrences step 2 already flagged — or rewrote — aren't re-flagged here.
  const handledRanges: Array<[number, number]> = [];
  serverRe.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = serverRe.exec(output)) !== null) {
    handledRanges.push([hm.index, hm.index + hm[0].length]);
  }

  const residualRe = /(["'])convex\/server\1/g;
  let m: RegExpExecArray | null;
  while ((m = residualRe.exec(output)) !== null) {
    if (handledRanges.some(([start, end]) => m!.index >= start && m!.index < end)) continue;
    entries.push({ severity: "action-needed", file, line: lineOf(output, m.index), what: `import "convex/server"`, fix: `map manually: defineSchema/defineTable → "@helipod/values"; httpRouter/httpAction → "./_generated/server"` });
  }

  return { output, entries };
}
