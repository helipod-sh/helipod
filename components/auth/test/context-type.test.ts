import { describe, it, expect } from "vitest";
import { auth } from "../src/component";

describe("auth contextType (for codegen)", () => {
  it("declares its ctx contribution type", () => {
    expect(auth.contextType).toEqual({ import: "@stackbase/auth", type: "AuthContext" });
  });
});
