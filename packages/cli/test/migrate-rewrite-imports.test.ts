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

  it("convex/server: mixed/unknown symbols are NOT rewritten and are flagged action-needed", () => {
    const src = `import { defineSchema, cronJobs } from "convex/server";`;
    const r = rewriteImports(src, "x.ts");
    expect(r.output).toBe(src); // unchanged
    expect(r.entries[0]).toMatchObject({ severity: "action-needed", file: "x.ts" });
  });

  it("leaves ./_generated/server untouched", () => {
    const src = `import { query, mutation } from "./_generated/server";`;
    const r = rewriteImports(src, "m.ts");
    expect(r.output).toBe(src);
    expect(r.entries).toHaveLength(0);
  });
});
