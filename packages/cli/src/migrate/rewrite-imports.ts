import type { ReportEntry } from "./source";

/** Unambiguous specifier → target rewrites (applied wherever the quoted specifier appears). */
const SIMPLE: Record<string, string> = {
  "convex/values": "@stackbase/values",
  "convex/react": "@stackbase/client/react",
  "convex/browser": "@stackbase/client",
};

const SCHEMA_SYMBOLS = new Set(["defineSchema", "defineTable"]);
const SERVER_SYMBOLS = new Set(["httpRouter", "httpAction"]);

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * Rewrite Convex import specifiers to their Stackbase equivalents. Operates on the quoted module
 * specifier so `import`, `export … from`, `require()`, and dynamic `import()` are all handled.
 * `convex/server` is symbol-aware; `./_generated/server` is left alone.
 */
export function rewriteImports(source: string, file: string): { output: string; entries: ReportEntry[] } {
  const entries: ReportEntry[] = [];
  let output = source;

  // 1. Unambiguous specifiers — replace every quoted occurrence.
  for (const [from, to] of Object.entries(SIMPLE)) {
    const re = new RegExp(`(["'])${from.replace("/", "\\/")}\\1`, "g");
    output = output.replace(re, (_m, q, offset: number) => {
      entries.push({ severity: "auto-fixed", file, line: lineOf(source, offset), what: `import "${from}"`, fix: `rewritten to "${to}"` });
      return `${q}${to}${q}`;
    });
  }

  // 2. convex/server — symbol-aware (single-line brace clause only).
  const serverRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])convex\/server\2/g;
  output = output.replace(serverRe, (full, names: string, q: string, offset: number) => {
    const line = lineOf(source, offset);
    const syms = names.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    const allSchema = syms.length > 0 && syms.every((s) => SCHEMA_SYMBOLS.has(s));
    const allServer = syms.length > 0 && syms.every((s) => SERVER_SYMBOLS.has(s));
    if (allSchema) {
      entries.push({ severity: "auto-fixed", file, line, what: `import "convex/server" (schema)`, fix: `rewritten to "@stackbase/values"` });
      return full.replace(/["']convex\/server["']/, `${q}@stackbase/values${q}`);
    }
    if (allServer) {
      entries.push({ severity: "auto-fixed", file, line, what: `import "convex/server" (http)`, fix: `rewritten to "./_generated/server"` });
      return full.replace(/["']convex\/server["']/, `${q}./_generated/server${q}`);
    }
    entries.push({ severity: "action-needed", file, line, what: `import { ${syms.join(", ")} } from "convex/server"`, fix: `map each symbol manually: defineSchema/defineTable → "@stackbase/values"; httpRouter/httpAction → "./_generated/server"` });
    return full; // leave unchanged
  });

  // 3. Any convex/server occurrence NOT matched above (default import, multiline, require, dynamic).
  const residualRe = /(["'])convex\/server\1/g;
  let m: RegExpExecArray | null;
  while ((m = residualRe.exec(output)) !== null) {
    entries.push({ severity: "action-needed", file, line: lineOf(output, m.index), what: `import "convex/server"`, fix: `map manually: defineSchema/defineTable → "@stackbase/values"; httpRouter/httpAction → "./_generated/server"` });
  }

  return { output, entries };
}
