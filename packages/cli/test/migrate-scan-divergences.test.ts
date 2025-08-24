import { describe, it, expect } from "vitest";
import { scanDivergences } from "../src/migrate/scan-divergences";

describe("scanDivergences", () => {
  it("flags .withIndex, ctx.db.patch, and .paginate as action-needed with line numbers", () => {
    const src = [
      `const a = ctx.db.query("m").withIndex("by_x", q => q.eq("x", 1));`,
      `await ctx.db.patch(id, { seen: true });`,
      `const p = await ctx.db.query("m").paginate(opts);`,
    ].join("\n");
    const e = scanDivergences(src, "m.ts");
    expect(e.map((x) => x.what)).toEqual(expect.arrayContaining([
      expect.stringContaining("withIndex"),
      expect.stringContaining("patch"),
      expect.stringContaining("paginate"),
    ]));
    expect(e.every((x) => x.severity === "action-needed")).toBe(true);
    expect(e.find((x) => x.what.includes("withIndex"))?.line).toBe(1);
    expect(e.find((x) => x.what.includes("patch"))?.line).toBe(2);
  });

  it("flags ctx.auth / getUserIdentity as action-needed", () => {
    const e = scanDivergences(`const id = await ctx.auth.getUserIdentity();`, "a.ts");
    expect(e[0]?.severity).toBe("action-needed");
  });

  it("flags Convex Auth and vector/search as unsupported", () => {
    expect(scanDivergences(`import {} from "@convex-dev/auth/server";`, "a.ts")[0]?.severity).toBe("unsupported");
    expect(scanDivergences(`table.vectorIndex("by_embedding", { vectorField: "e", dimensions: 1536 });`, "schema.ts")[0]?.severity).toBe("unsupported");
  });

  it("flags a crons file by name", () => {
    const e = scanDivergences(`export default cronJobs();`, "crons.ts");
    expect(e[0]).toMatchObject({ severity: "action-needed" });
    expect(e[0]?.what.toLowerCase()).toContain("cron");
  });

  it("returns nothing for a clean file", () => {
    expect(scanDivergences(`export const x = 1;\n`, "clean.ts")).toEqual([]);
  });
});
