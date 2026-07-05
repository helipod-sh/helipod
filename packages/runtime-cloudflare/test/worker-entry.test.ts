/**
 * The Worker-entry codegen (Task 7). `generateWorkerEntrySource` is the DO twin of `helipod build`'s
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
    configAbsPath: "/app/convex/helipod.config.js",
    bindingName: "HELIPOD_DO",
    doClassName: "HelipodDO",
  });

  it("statically imports every module + schema + config (no dir scan, no top-level await)", () => {
    expect(src).toContain(`import * as m0 from "/app/convex/messages.js";`);
    expect(src).toContain(`import * as m1 from "/app/convex/http.js";`);
    expect(src).toContain(`import schema from "/app/convex/schema.js";`);
    expect(src).toContain(`import * as __config from "/app/convex/helipod.config.js";`);
    expect(src).not.toMatch(/\bawait\b/); // a Worker top level must be synchronous
  });

  it("reconstructs the { schema, modules } loadProject shape and reads components off the config", () => {
    expect(src).toContain(`"messages": m0`);
    expect(src).toContain(`"http": m1`);
    expect(src).toContain(`const components = (__config.default ?? __config).components ?? [];`);
  });

  it("exports a concrete DO class (named in wrangler) + the default Worker handler", () => {
    expect(src).toContain(`export class HelipodDO extends HelipodDurableObject {`);
    expect(src).toContain(`export default createWorkerHandler("HELIPOD_DO");`);
    // Admin key is read from the env at boot (fail-fast on empty happens in serve; here it's threaded).
    expect(src).toContain(`env["HELIPOD_ADMIN_KEY"]`);
  });

  it("wires an R2 blob store when r2BindingName is set (byte storage on the deployed DO)", () => {
    const withR2 = generateWorkerEntrySource({
      moduleImports: [{ key: "files", absPath: "/x/files.js" }],
      schemaAbsPath: "/x/schema.js",
      configAbsPath: null,
      bindingName: "DO",
      doClassName: "MyDO",
      r2BindingName: "STORAGE_BUCKET",
    });
    expect(withR2).toContain(`import { R2BlobStore } from "@helipod/blobstore-r2";`);
    expect(withR2).toContain(`env["STORAGE_BUCKET"]`);
    expect(withR2).toContain(`new R2BlobStore({ bucket: __bucket })`);
    expect(withR2).not.toMatch(/\bawait\b/);
  });

  it("omits the R2 import + blobStore when r2BindingName is absent (byte-less deploy)", () => {
    expect(src).not.toContain("@helipod/blobstore-r2");
    expect(src).not.toContain("R2BlobStore");
  });

  it("omits the config import + empties components when there is no helipod.config", () => {
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
