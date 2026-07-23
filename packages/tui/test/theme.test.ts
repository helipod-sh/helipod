/**
 * FFI-free tests for @helipod/tui: the theme is the brand contract (website dark
 * tokens), and importing the package surface must never touch OpenTUI's native
 * renderer (that only happens inside runDashboard()).
 */
import { describe, it, expect } from "vitest";
import { helipodTheme } from "../src/lib/terminal-themes/helipod";

describe("helipod terminal theme", () => {
  it("carries the website dark palette", () => {
    expect(helipodTheme.colors.background).toBe("#14110e");
    expect(helipodTheme.colors.foreground).toBe("#f2eee9");
    expect(helipodTheme.colors.primary).toBe("#e04667"); // the helipod crimson
    expect(helipodTheme.colors.border).toBe("#332c28");
  });

  it("defines every semantic slot components consume", () => {
    for (const slot of ["success", "warning", "error", "info", "muted", "mutedForeground", "selection", "focusRing"]) {
      expect(helipodTheme.colors[slot as keyof typeof helipodTheme.colors], slot).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
