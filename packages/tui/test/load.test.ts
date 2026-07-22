/**
 * Regression: `runDashboard()` must load OpenTUI's core, the React binding, and
 * our app in that order.
 *
 * Loading them with `Promise.all` raced their module initialization and threw
 * "Cannot access 'TextNodeRenderable' before initialization" at runtime — the
 * dashboard silently fell back to plain output. Every other test imports the
 * app statically, so only an isolated dynamic load reproduces it.
 */
import { test, expect } from "bun:test";

test("the package's dynamic load order initializes cleanly", async () => {
  const { runDashboard } = await import("../src/index");
  expect(typeof runDashboard).toBe("function");

  // Import exactly as runDashboard does — sequentially — and touch a symbol from
  // each module so a TDZ error would surface here rather than in a user's terminal.
  const core = await import("@opentui/core");
  const react = await import("@opentui/react");
  const app = await import("../src/app");

  expect(typeof core.createCliRenderer).toBe("function");
  expect(typeof react.createRoot).toBe("function");
  expect(typeof app.App).toBe("function");
  expect(typeof app.mount).toBe("function");
});
