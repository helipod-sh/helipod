import { describe, it, expect } from "vitest";
import { defineSchema } from "@helipod/values";
import { mutation, query } from "@helipod/executor";
import { defineComponent } from "../src/define-component";
import { composeModules } from "../src/compose";

const empty = defineSchema({});
const auth = defineComponent({ name: "auth", schema: empty, modules: { signIn: mutation(async () => "t"), getSession: query(async () => null) } });
const app = { "messages:list": query(async () => []) };

describe("composeModules", () => {
  it("prefixes component functions and preserves app functions", () => {
    const map = composeModules(app, [auth]);
    expect(Object.keys(map).sort()).toEqual(["auth:getSession", "auth:signIn", "messages:list"]);
    expect(map["auth:signIn"]).toBe(auth.modules.signIn);
  });

  it("rejects duplicate component names", () => {
    const a2 = defineComponent({ name: "auth", schema: empty, modules: {} });
    expect(() => composeModules(app, [auth, a2])).toThrow(/duplicate/);
  });

  it("rejects a component name that collides with an app module prefix", () => {
    expect(() => composeModules({ "auth:foo": query(async () => 1) }, [auth])).toThrow(/collides/);
  });

  it("detects collision with a colon-free (bare) app module key", () => {
    const bare = defineComponent({ name: "auth", schema: empty, modules: {} });
    expect(() => composeModules({ auth: query(async () => 1) }, [bare])).toThrow(/collides/);
  });
});
