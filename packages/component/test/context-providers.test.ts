// packages/component/test/context-providers.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema } from "@stackbase/values";
import { defineComponent } from "../src/define-component";
import { composeComponents } from "../src/compose";

const withCtx = defineComponent({
  name: "auth",
  schema: defineSchema({}),
  modules: {},
  context: (cctx) => ({ getUserId: async () => (cctx.identity ? "u" : null) }),
});
const noCtx = defineComponent({ name: "plain", schema: defineSchema({}), modules: {} });

describe("composeComponents — context providers", () => {
  it("derives one provider per component that declares context", () => {
    const out = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [withCtx, noCtx]);
    expect(out.contextProviders.map((p) => p.name)).toEqual(["auth"]);
    expect(out.contextProviders[0]!.namespace).toBe("auth");
    expect(typeof out.contextProviders[0]!.build).toBe("function");
  });
});
