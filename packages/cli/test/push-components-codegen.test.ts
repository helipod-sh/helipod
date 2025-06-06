import { describe, it, expect } from "vitest";
import { defineSchema } from "@stackbase/values";
import { defineComponent } from "@stackbase/component";
import { push, type LoadedProject } from "../src/index";

describe("push with components passes contextType into codegen", () => {
  it("emits declare module augmentation in server.ts when component has contextType", () => {
    const auth = defineComponent({
      name: "auth",
      schema: defineSchema({}),
      modules: {},
      context: () => ({}),
      contextType: { import: "@stackbase/auth", type: "AuthContext" },
    });

    const loaded: LoadedProject = { schema: defineSchema({}), modules: {} };
    const { generated } = push(loaded, [auth]);

    expect(generated.server.content).toContain('declare module "@stackbase/executor"');
    expect(generated.server.content).toContain('auth: import("@stackbase/auth").AuthContext');
  });

  it("does NOT emit augmentation when no components have contextType", () => {
    const noCtx = defineComponent({ name: "plain", schema: defineSchema({}), modules: {} });
    const loaded: LoadedProject = { schema: defineSchema({}), modules: {} };
    const { generated } = push(loaded, [noCtx]);
    expect(generated.server.content).not.toContain('declare module "@stackbase/executor"');
  });

  it("does NOT emit augmentation when components list is empty (default)", () => {
    const loaded: LoadedProject = { schema: defineSchema({}), modules: {} };
    const { generated } = push(loaded);
    expect(generated.server.content).not.toContain('declare module "@stackbase/executor"');
  });
});
