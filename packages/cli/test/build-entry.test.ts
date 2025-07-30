import { describe, it, expect } from "vitest";
import { generateEntrySource } from "../src/build-entry";

describe("generateEntrySource", () => {
  const base = {
    moduleImports: [{ key: "messages", absPath: "/app/convex/messages.ts" }, { key: "users", absPath: "/app/convex/users.ts" }],
    schemaAbsPath: "/app/convex/schema.ts",
    configAbsPath: "/app/stackbase.config.ts",
    dashboardFiles: null,
  };

  it("statically imports each module, the schema, the config, and runBinaryServer", () => {
    const src = generateEntrySource(base);
    expect(src).toContain(`import * as m0 from "/app/convex/messages.ts"`);
    expect(src).toContain(`import * as m1 from "/app/convex/users.ts"`);
    expect(src).toContain(`import schema from "/app/convex/schema.ts"`);
    expect(src).toContain(`import * as __config from "/app/stackbase.config.ts"`);
    expect(src).toContain(`import { runBinaryServer } from "@stackbase/cli"`);
    expect(src).toContain(`modules: { "messages": m0, "users": m1 }`);
    expect(src).toContain(`const components = (__config.default ?? __config).components ?? []`);
    expect(src).toContain(`runBinaryServer(loaded, components,`);
  });

  it("emits components = [] when there is no config", () => {
    const src = generateEntrySource({ ...base, configAbsPath: null });
    expect(src).not.toContain("__config");
    expect(src).toContain(`const components = []`);
  });

  it("emits a dashboard map of {type:'file'} imports, or undefined when omitted", () => {
    const withDash = generateEntrySource({ ...base, dashboardFiles: [
      { urlPath: "/", absPath: "/d/index.html" },
      { urlPath: "/assets/a.js", absPath: "/d/assets/a.js" },
    ] });
    expect(withDash).toContain(`import d0 from "/d/index.html" with { type: "file" }`);
    expect(withDash).toContain(`import d1 from "/d/assets/a.js" with { type: "file" }`);
    expect(withDash).toContain(`"/": d0`);
    expect(withDash).toContain(`"/assets/a.js": d1`);
    expect(withDash).toContain(`runBinaryServer(loaded, components, dashboard)`);
    expect(generateEntrySource(base)).toContain(`runBinaryServer(loaded, components, undefined)`);
  });
});
