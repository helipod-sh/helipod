import { describe, it, expect } from "vitest";
import { DeployError, type DeployTarget } from "../src/index";

describe("@stackbase/deploy seam types", () => {
  it("a minimal object satisfies DeployTarget and DeployError is an Error", async () => {
    const noop: DeployTarget = {
      name: "noop",
      async preflight() {},
      async package() {},
      async push() { return { ok: true, detail: "noop" }; },
    };
    expect(noop.name).toBe("noop");
    expect((await noop.push({} as never)).ok).toBe(true);
    expect(new DeployError("x")).toBeInstanceOf(Error);
  });
});
