// packages/codegen/test/ctx-augmentation.test.ts
import { describe, it, expect } from "vitest";
import { generateServer } from "../src/generate";

const emptySchema = { tables: {} } as never;

describe("generateServer — ctx augmentation", () => {
  it("emits a typed ctx.<component> augmentation for components with a contextType", () => {
    const out = generateServer(emptySchema, {
      components: [{ name: "auth", contextType: { import: "@stackbase/auth", type: "AuthContext" } }],
    });
    expect(out.content).toContain('declare module "@stackbase/executor"');
    expect(out.content).toContain('auth: import("@stackbase/auth").AuthContext');
    expect(out.content).toContain("interface QueryCtx");
    expect(out.content).toContain("interface MutationCtx");
  });

  it("emits no augmentation when there are no components with a contextType", () => {
    const out = generateServer(emptySchema, {});
    expect(out.content).not.toContain("declare module");
  });

  it("emits no augmentation when components have no contextType", () => {
    const out = generateServer(emptySchema, { components: [{ name: "noCtx" }] });
    expect(out.content).not.toContain("declare module");
  });

  it("emits augmentation for multiple components", () => {
    const out = generateServer(emptySchema, {
      components: [
        { name: "auth", contextType: { import: "@stackbase/auth", type: "AuthContext" } },
        { name: "storage", contextType: { import: "@stackbase/storage", type: "StorageContext" } },
        { name: "noCtx" },
      ],
    });
    expect(out.content).toContain('auth: import("@stackbase/auth").AuthContext');
    expect(out.content).toContain('storage: import("@stackbase/storage").StorageContext');
    expect(out.content).not.toContain("noCtx");
  });
});
