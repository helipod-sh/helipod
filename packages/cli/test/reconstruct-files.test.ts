import { describe, it, expect } from "vitest";
import { sha256Hex } from "@helipod/deploy";
import { reconstructFiles } from "../src/deploy-apply";

const cur = new Map([
  ["a.js", { code: "A", sha: sha256Hex("A") }],
  ["b.js", { code: "B", sha: sha256Hex("B") }],
]);

describe("reconstructFiles", () => {
  it("passes a legacy {files} payload straight through", () => {
    const r = reconstructFiles({ files: [{ path: "x.js", code: "X" }] }, new Map());
    expect(r).toEqual({ ok: true, files: [{ path: "x.js", code: "X" }] });
  });

  it("rebuilds the full tree from changed + unchanged (resolved from currentModules)", () => {
    const r = reconstructFiles(
      { changed: [{ path: "b.js", code: "B2" }], unchanged: [{ path: "a.js", sha256: sha256Hex("A") }] },
      cur,
    );
    expect(r.ok).toBe(true);
    expect((r as { files: unknown }).files).toEqual([
      { path: "b.js", code: "B2" },
      { path: "a.js", code: "A" },
    ]);
  });

  it("returns stale-base when an unchanged path is unknown to the server", () => {
    const r = reconstructFiles({ changed: [], unchanged: [{ path: "ghost.js", sha256: "deadbeef" }] }, cur);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("stale-base") });
  });

  it("returns stale-base when an unchanged sha disagrees with the server's", () => {
    const r = reconstructFiles({ changed: [], unchanged: [{ path: "a.js", sha256: sha256Hex("DIFFERENT") }] }, cur);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("stale-base") });
  });

  it("drops a current module the delta does not reference (deletion by omission)", () => {
    // Only a.js is referenced; b.js is intentionally absent from both lists → not in the rebuilt tree.
    const r = reconstructFiles({ changed: [], unchanged: [{ path: "a.js", sha256: sha256Hex("A") }] }, cur);
    expect(r.ok).toBe(true);
    expect((r as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(["a.js"]);
  });
});
