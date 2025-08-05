import { describe, it, expect } from "vitest";
import { isPostgresUrl } from "../src/boot";

describe("backend selection", () => {
  it("recognizes postgres connection strings", () => {
    expect(isPostgresUrl("postgres://u:p@host:5432/db")).toBe(true);
    expect(isPostgresUrl("postgresql://host/db")).toBe(true);
    expect(isPostgresUrl(undefined)).toBe(false);
    expect(isPostgresUrl("./data/db.sqlite")).toBe(false);
    expect(isPostgresUrl("")).toBe(false);
  });
});
