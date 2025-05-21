import { describe, it, expect } from "vitest";
import { hasBody } from "../src/server";

describe("hasBody (request body reading)", () => {
  it("reads a body for POST/PUT/PATCH but not GET/DELETE", () => {
    expect(hasBody("POST")).toBe(true);
    expect(hasBody("PUT")).toBe(true);
    // Regression: the admin doc-edit PATCH must reach the handler with its body, else patches
    // silently no-op (`fields` parses to `{}`).
    expect(hasBody("PATCH")).toBe(true);
    expect(hasBody("GET")).toBe(false);
    expect(hasBody("DELETE")).toBe(false);
    expect(hasBody(undefined)).toBe(false);
  });
});
