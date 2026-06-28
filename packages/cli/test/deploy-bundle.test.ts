import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDeployOptions, packageApp } from "../src/deploy";
import { DEFAULT_FUNCTIONS_DIR } from "../src/functions-dir";

describe("resolveDeployOptions", () => {
  it("resolves --url + STACKBASE_ADMIN_KEY", async () => {
    const r = await resolveDeployOptions(["--url", "http://x:1"], { STACKBASE_ADMIN_KEY: "k" } as NodeJS.ProcessEnv);
    // No `--dir` and no `stackbase.config.ts` at cwd → DEFAULT_FUNCTIONS_DIR, resolved absolute.
    expect(r).toEqual({ url: "http://x:1", functionsDir: resolve(process.cwd(), DEFAULT_FUNCTIONS_DIR), adminKey: "k" });
  });
  it("falls back to STACKBASE_DEPLOY_URL", async () => {
    const r = await resolveDeployOptions([], { STACKBASE_ADMIN_KEY: "k", STACKBASE_DEPLOY_URL: "http://y:2" } as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ url: "http://y:2" });
  });
  it("errors on missing url", async () => {
    expect(await resolveDeployOptions([], { STACKBASE_ADMIN_KEY: "k" } as NodeJS.ProcessEnv)).toHaveProperty("error");
  });
  it("errors on missing/blank admin key", async () => {
    expect(await resolveDeployOptions(["--url", "http://x:1"], { STACKBASE_ADMIN_KEY: "  " } as NodeJS.ProcessEnv)).toHaveProperty("error");
  });
});

describe("packageApp", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pkg-"));
    writeFileSync(join(dir, "schema.ts"), `import { defineSchema } from "@stackbase/values";\nexport default defineSchema({});\nconst x: number = 1; void x;\n`);
    writeFileSync(join(dir, "messages.ts"), `import { query } from "./_generated/server";\nexport const list = query({ handler: () => [] });\n`);
    mkdirSync(join(dir, "_generated"));
    writeFileSync(join(dir, "_generated", "server.ts"), `export { query } from "@stackbase/executor";\n`);
    writeFileSync(join(dir, "_generated", "api.d.ts"), `export type API = unknown;\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("transpiles every .ts (not .d.ts) preserving the tree, imports untouched", async () => {
    const files = await packageApp(dir);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.code]));
    expect(Object.keys(byPath).sort()).toEqual(["_generated/server.js", "messages.js", "schema.js"]);
    // TS types stripped, but bare + relative imports pass through verbatim (external — resolved on the remote).
    expect(byPath["schema.js"]).toMatch(/@stackbase\/values/);
    expect(byPath["schema.js"]).not.toMatch(/: number/);
    expect(byPath["messages.js"]).toMatch(/\.\/_generated\/server/);
    expect(byPath["_generated/server.js"]).toMatch(/@stackbase\/executor/);
  });
});
