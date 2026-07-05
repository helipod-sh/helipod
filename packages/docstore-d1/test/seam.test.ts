import { describe, it, expect } from "vitest";
import { UniqueConstraintError } from "../src/index";
describe("@helipod/docstore-d1 seam", () => {
  it("UniqueConstraintError carries table + field", () => {
    const e = new UniqueConstraintError("users", "email");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("UniqueConstraintError");
    expect([e.table, e.field]).toEqual(["users", "email"]);
  });
});
