/**
 * The styling module's core contract: when output is not an interactive terminal
 * (which is exactly how this test runs — vitest pipes stdout), every helper is a
 * plain-text passthrough with zero ANSI escapes. Piped/CI/e2e output must stay
 * byte-identical to the pre-styling CLI.
 */
import { describe, it, expect } from "vitest";
import * as ui from "../src/ui";

// eslint-disable-next-line no-control-regex
const ANSI = /\[/;

describe("ui — plain-mode passthrough", () => {
  it("detects non-TTY and disables styling", () => {
    expect(ui.styled).toBe(false);
  });

  it("color helpers are identity functions when unstyled", () => {
    for (const fn of [ui.bold, ui.dim, ui.red, ui.green, ui.yellow, ui.blue, ui.magenta, ui.cyan, ui.brand]) {
      expect(fn("hello")).toBe("hello");
    }
  });

  it("symbols carry no escape codes", () => {
    for (const s of Object.values(ui.sym)) expect(s).not.toMatch(ANSI);
  });

  it("keyValues aligns keys and stays escape-free", () => {
    const out = ui.keyValues([
      ["API", "http://x"],
      ["Dashboard", "http://x/_dashboard"],
    ]);
    expect(out).not.toMatch(ANSI);
    const lines = out.split("\n");
    // values start at the same column
    const cols = lines.map((l) => l.indexOf("http://"));
    expect(new Set(cols).size).toBe(1);
  });

  it("status and errorBlock render plain, actionable text", () => {
    expect(ui.status("ok", "12 functions", "0.3s")).toBe("  ✓ 12 functions   0.3s");
    const block = ui.errorBlock("reload failed", "SyntaxError: oops\nat messages.ts:3", "fix the file");
    expect(block).not.toMatch(ANSI);
    expect(block).toContain("✗ reload failed");
    expect(block).toContain("    at messages.ts:3");
    expect(block).toContain("→ fix the file");
  });
});
