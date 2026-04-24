/**
 * The Worker-entry codegen (Task 7). `generateWorkerEntrySource` is the DO twin of `stackbase build`'s
 * static-import entrypoint — it must emit static imports of every app module/schema/config, a concrete
 * exported DO class (a DO binding REQUIRES one, §8.8), and the default Worker export, with NO
 * top-level `await` (a Worker module is synchronous at the top level; boot is lazy in the DO ctor).
 */
import { describe, it, expect } from "vitest";
import { generateWorkerEntrySource } from "../src/index";

describe("generateWorkerEntrySource", () => {
  const src = generateWorkerEntrySource({
    moduleImports: [
      { key: "messages", absPath: "/app/convex/messages.js" },
      { key: "http", absPath: "/app/convex/http.js" },
    ],
    schemaAbsPath: "/app/convex/schema.js",
    configAbsPath: "/app/convex/stackbase.config.js",
    bindingName: "STACKBASE_DO",
    doClassName: "StackbaseDO",
  });

  it("statically imports every module + schema + config (no dir scan, no top-level await)", () => {
    expect(src).toContain(`import * as m0 from "/app/convex/messages.js";`);
    expect(src).toContain(`import * as m1 from "/app/convex/http.js";`);
    expect(src).toContain(`import schema from "/app/convex/schema.js";`);
    expect(src).toContain(`import * as __config from "/app/convex/stackbase.config.js";`);
    expect(src).not.toMatch(/\bawait\b/); // a Worker top level must be synchronous
  });

  it("reconstructs the { schema, modules } loadProject shape and reads components off the config", () => {
    expect(src).toContain(`"messages": m0`);
    expect(src).toContain(`"http": m1`);
    expect(src).toContain(`const components = (__config.default ?? __config).components ?? [];`);
  });

  it("exports a concrete DO class (named in wrangler) + the default Worker handler", () => {
    expect(src).toContain(`export class StackbaseDO extends StackbaseDurableObject {`);
    expect(src).toContain(`export default createWorkerHandler("STACKBASE_DO");`);
    // Admin key is read from the env at boot (fail-fast on empty happens in serve; here it's threaded).
    expect(src).toContain(`env["STACKBASE_ADMIN_KEY"]`);
  });

  it("omits the config import + empties components when there is no stackbase.config", () => {
    const noCfg = generateWorkerEntrySource({
      moduleImports: [{ key: "a", absPath: "/x/a.js" }],
      schemaAbsPath: "/x/schema.js",
      configAbsPath: null,
      bindingName: "DO",
      doClassName: "MyDO",
    });
    expect(noCfg).not.toContain("__config");
    expect(noCfg).toContain("const components = [];");
  });
});
