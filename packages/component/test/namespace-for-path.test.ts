import { describe, it, expect } from "vitest";
import { namespaceForPath } from "../src/compose";

describe("namespaceForPath", () => {
  const names = new Set(["auth", "cron"]);
  it("returns the component name for a component function path", () => {
    expect(namespaceForPath("auth:signIn", names)).toBe("auth");
    expect(namespaceForPath("cron:tick", names)).toBe("cron");
  });
  it("returns '' for an app module path (prefix is not a component)", () => {
    expect(namespaceForPath("messages:list", names)).toBe("");
    expect(namespaceForPath("auth", names)).toBe(""); // colon-free → not a component fn key
  });
});
