import { describe, it, expect } from "vitest";
import { FLEET_VERSION } from "../src/index";

describe("@helipod/fleet scaffolding", () => {
  it("builds and imports", () => {
    expect(FLEET_VERSION).toBe("0.0.0");
  });
});
