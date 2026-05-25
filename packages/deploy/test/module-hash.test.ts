import { describe, it, expect } from "vitest";
import { sha256Hex, partitionModules } from "../src/module-hash";

describe("sha256Hex", () => {
  it("is deterministic lowercase hex over the utf8 code", () => {
    const a = sha256Hex("export const x = 1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("export const x = 1")).toBe(a);
    expect(sha256Hex("export const x = 2")).not.toBe(a);
  });
});

describe("partitionModules", () => {
  it("marks a file unchanged when the server has the same path+sha, changed otherwise", () => {
    const local = { files: [{ path: "a.js", code: "A" }, { path: "b.js", code: "B2" }, { path: "c.js", code: "C" }] };
    const remote = { "a.js": sha256Hex("A"), "b.js": sha256Hex("B1") /* b differs; c is new */ };
    const { changed, unchanged } = partitionModules(local, remote);
    expect(unchanged).toEqual([{ path: "a.js", sha256: sha256Hex("A") }]);
    expect(changed.map((c) => c.path).sort()).toEqual(["b.js", "c.js"]);
  });

  it("omits a server file the local tree no longer has (deletion by omission)", () => {
    const local = { files: [{ path: "a.js", code: "A" }] };
    const remote = { "a.js": sha256Hex("A"), "gone.js": sha256Hex("X") };
    const { changed, unchanged } = partitionModules(local, remote);
    expect(changed).toEqual([]);
    expect(unchanged).toEqual([{ path: "a.js", sha256: sha256Hex("A") }]);
    // "gone.js" is in neither list.
    expect([...changed, ...unchanged].some((e) => e.path === "gone.js")).toBe(false);
  });
});
