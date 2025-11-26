/** The browser entrypoints must never grow a node builtin import — outbox-fs is the only file
 *  allowed to touch node:*, and it ships as its own subpath entry. Guards the split at the
 *  artifact level (dist is built before tests in the turbo pipeline). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("dist browser cleanliness", () => {
  it.each(["index.js", "react.js"])("dist/%s contains no node: specifier", (file) => {
    const src = readFileSync(join(__dirname, "..", "dist", file), "utf8");
    expect(src).not.toMatch(/["']node:[a-z/]+["']/);
  });
  it("dist/outbox-fs.js exists and is the only node:-importing entry", () => {
    const src = readFileSync(join(__dirname, "..", "dist", "outbox-fs.js"), "utf8");
    expect(src).toMatch(/node:fs/);
  });
});
