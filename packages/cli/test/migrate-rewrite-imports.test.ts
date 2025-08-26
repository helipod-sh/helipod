import { describe, it, expect } from "vitest";
import { rewriteImports } from "../src/migrate/rewrite-imports";

describe("rewriteImports", () => {
  it("rewrites convex/values → @stackbase/values (import + entry)", () => {
    const r = rewriteImports(`import { v } from "convex/values";\n`, "schema.ts");
    expect(r.output).toBe(`import { v } from "@stackbase/values";\n`);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ severity: "auto-fixed", file: "schema.ts", line: 1 });
  });

  it("rewrites convex/react → @stackbase/client/react and convex/browser → @stackbase/client", () => {
    expect(rewriteImports(`import { X } from "convex/react";`, "a.tsx").output).toContain(`"@stackbase/client/react"`);
    expect(rewriteImports(`import { X } from "convex/browser";`, "a.ts").output).toContain(`"@stackbase/client"`);
  });

  it("covers export-from, require, and dynamic import forms", () => {
    expect(rewriteImports(`export { v } from "convex/values";`, "a.ts").output).toContain(`"@stackbase/values"`);
    expect(rewriteImports(`const { v } = require("convex/values");`, "a.ts").output).toContain(`"@stackbase/values"`);
    expect(rewriteImports(`await import("convex/values");`, "a.ts").output).toContain(`"@stackbase/values"`);
  });

  it("convex/server: schema symbols → @stackbase/values", () => {
    const r = rewriteImports(`import { defineSchema, defineTable } from "convex/server";`, "schema.ts");
    expect(r.output).toContain(`from "@stackbase/values"`);
    expect(r.entries[0]?.severity).toBe("auto-fixed");
  });

  it("convex/server: httpRouter/httpAction → ./_generated/server", () => {
    const r = rewriteImports(`import { httpRouter, httpAction } from "convex/server";`, "http.ts");
    expect(r.output).toContain(`from "./_generated/server"`);
  });

  it("convex/server: mixed/unknown symbols are NOT rewritten and are flagged action-needed exactly once", () => {
    const src = `import { defineSchema, cronJobs } from "convex/server";`;
    const r = rewriteImports(src, "x.ts");
    expect(r.output).toBe(src); // unchanged
    expect(r.entries).toHaveLength(1); // was double-counted by the step-2 flag + step-3 residual re-scan
    expect(r.entries[0]).toMatchObject({ severity: "action-needed", file: "x.ts" });
  });

  it("convex/server: a cronJobs import gets cron-specific fix advice (not the generic defineSchema/httpRouter mapping)", () => {
    const r = rewriteImports(`import { cronJobs } from "convex/server";`, "crons.ts");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ severity: "action-needed", file: "crons.ts" });
    expect(r.entries[0]?.fix).toMatch(/@stackbase\/scheduler|defineScheduler/);
  });

  it("convex/server: cronJobs mixed with another symbol still surfaces cron-specific advice", () => {
    const r = rewriteImports(`import { defineSchema, cronJobs } from "convex/server";`, "x.ts");
    expect(r.entries[0]?.fix).toMatch(/@stackbase\/scheduler|defineScheduler/);
  });

  it("leaves ./_generated/server untouched", () => {
    const src = `import { query, mutation } from "./_generated/server";`;
    const r = rewriteImports(src, "m.ts");
    expect(r.output).toBe(src);
    expect(r.entries).toHaveLength(0);
  });

  it("reports correct line numbers when same-mapping rewrites stack before a different-mapping import", () => {
    const stackedLines = Array.from({ length: 8 }, () => `import { v } from "convex/values";`).join("\n");
    const src = `${stackedLines}\nimport { X } from "convex/react";\n`;
    const r = rewriteImports(src, "a.ts");
    expect(r.entries).toHaveLength(9);
    const reactEntry = r.entries.find((e) => e.what.includes("convex/react"));
    expect(reactEntry).toBeDefined();
    expect(reactEntry?.line).toBe(9); // was misreported as 10 (lineOf indexed original source with a mutated-output offset)
  });

  it("convex/server: require() form is not brace-parsed and is flagged action-needed", () => {
    const src = `const x = require("convex/server");`;
    const r = rewriteImports(src, "x.ts");
    expect(r.output).toBe(src);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ severity: "action-needed", file: "x.ts" });
  });

  it("convex/server: export-from brace clause is not matched by the import-anchored regex and is flagged action-needed", () => {
    const src = `export { defineSchema } from "convex/server";`;
    const r = rewriteImports(src, "x.ts");
    expect(r.output).toBe(src);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ severity: "action-needed", file: "x.ts" });
  });
});
