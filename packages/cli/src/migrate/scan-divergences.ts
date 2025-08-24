import { basename } from "node:path";
import type { ReportEntry, ReportSeverity } from "./source";

interface Rule {
  test: RegExp;
  severity: ReportSeverity;
  what: string;
  fix: string;
}

const RULES: Rule[] = [
  { test: /\.withIndex\s*\(/, severity: "action-needed", what: ".withIndex(...) query",
    fix: `Stackbase has no .withIndex — use ctx.db.query(table, "index").eq(f, v).gte(f, v).order("asc"|"desc").collect()` },
  { test: /ctx\.db\.patch\s*\(/, severity: "action-needed", what: "ctx.db.patch(...)",
    fix: `Stackbase has no patch — read the doc, spread-merge, ctx.db.replace(id, { ...doc, ...changes })` },
  { test: /\.paginate\s*\(/, severity: "action-needed", what: ".paginate(...)",
    fix: `Stackbase paginate({ cursor, pageSize, maxScan? }) returns { page, nextCursor, hasMore, scanCapped }` },
  { test: /ctx\.auth\b|getUserIdentity\s*\(/, severity: "action-needed", what: "ctx.auth / getUserIdentity()",
    fix: `Identity is a string token via a context provider (e.g. @stackbase/auth's ctx.auth), not a JWT-claims object` },
  { test: /@convex-dev\/auth|["']convex\/auth["']/, severity: "unsupported", what: "Convex Auth",
    fix: `Auth is not auto-translated — use @stackbase/auth or external JWT` },
  { test: /\bapp\.use\s*\(/, severity: "unsupported", what: "Convex Component (app.use)",
    fix: `Convex Components don't map 1:1 — recompose via stackbase.config.ts` },
  { test: /\.vectorIndex\s*\(|\.searchIndex\s*\(/, severity: "unsupported", what: "vector/search index",
    fix: `search/vector is not yet supported in Stackbase (see roadmap)` },
];

/** Line-based scan for Convex runtime-API divergences Stackbase does NOT auto-transform. */
export function scanDivergences(source: string, file: string): ReportEntry[] {
  const entries: ReportEntry[] = [];
  const lines = source.split("\n");

  // Whole-file signals keyed on filename.
  const base = basename(file);
  if (base === "crons.ts" || /\bcronJobs\s*\(/.test(source)) {
    const idx = lines.findIndex((l) => /\bcronJobs\s*\(/.test(l));
    entries.push({ severity: "action-needed", file, line: idx >= 0 ? idx + 1 : 1, what: "Convex crons (cronJobs)",
      fix: `Compose defineScheduler() in stackbase.config.ts and use cronJobs() from "@stackbase/scheduler"` });
  }
  if (base === "convex.config.ts") {
    entries.push({ severity: "unsupported", file, line: 1, what: "Convex app config (convex.config.ts)",
      fix: `Recompose components via stackbase.config.ts` });
  }

  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.test.test(lines[i]!)) {
        entries.push({ severity: rule.severity, file, line: i + 1, what: rule.what, fix: rule.fix });
      }
    }
  }
  return entries;
}
