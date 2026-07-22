/* @jsxImportSource @opentui/react */
/**
 * Frame test: renders the real dashboard through OpenTUI's headless test renderer
 * and asserts on the captured character frame. This is the layout regression net —
 * it caught the first draft's dead space, floating footer, and leaked host version.
 *
 * Requires the native renderer (FFI), so it runs under `bun test` (see the package's
 * `test:frame` script) rather than the vitest lane, which runs under Node.
 */
import { describe, it, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import type { TuiBridge, TuiEvent } from "../src/bridge";

/** The React reconciler commits asynchronously; give it a tick before capturing. */
const settle = () => new Promise((r) => setTimeout(r, 50));

function makeBridge(): { bridge: TuiBridge; emit: (e: TuiEvent) => void } {
  const listeners = new Set<(e: TuiEvent) => void>();
  return {
    emit: (e) => listeners.forEach((cb) => cb(e)),
    bridge: {
      deployment: {
        url: "http://127.0.0.1:3210",
        dashboardUrl: "http://127.0.0.1:3210/_dashboard",
        adminKeyPreview: "cxgr6-v…foI_",
        functionsDir: "helipod",
        storage: "sqlite",
        version: "9.9.9",
      },
      counts: () => ({ functions: 11, tables: 5, components: 1 }),
      onEvent: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      requestQuit: () => {},
    },
  };
}

describe("dashboard frame", () => {
  it("fills the terminal: header on top, status bar on the last row", async () => {
    const { renderer, renderOnce, flush, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    const { bridge } = makeBridge();
    createRoot(renderer).render(<App bridge={bridge} />);
    await settle();
    await flush();
    await renderOnce();

    const lines = captureCharFrame().split("\n");
    expect(lines[0]).toContain("helipod");
    expect(lines[0]).toContain("127.0.0.1:3210");

    // The status bar owns the bottom row — not floating mid-screen.
    const lastNonEmpty = lines.filter((l) => l.trim().length > 0).at(-1) ?? "";
    expect(lastNonEmpty).toContain("quit");
    const statusRow = lines.findIndex((l) => l.includes("quit"));
    expect(statusRow).toBeGreaterThanOrEqual(lines.length - 3);

    renderer.destroy();
  });

  it("shows deployment facts and the project summary, with helipod's own version", async () => {
    const { renderer, renderOnce, flush, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    const { bridge } = makeBridge();
    createRoot(renderer).render(<App bridge={bridge} />);
    await settle();
    await flush();
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame).toContain("deployment");
    expect(frame).toContain("_dashboard");
    expect(frame).toContain("cxgr6-v…foI_"); // truncated key only — never the full secret
    expect(frame).toContain("sqlite");
    expect(frame).toContain("9.9.9"); // the version the host passed, not npm_package_version
    expect(frame).toContain("11"); // functions
    expect(frame).toMatch(/waiting/i); // empty-state copy

    renderer.destroy();
  });

  it("renders host events in the activity area", async () => {
    const { renderer, renderOnce, flush, captureCharFrame } = await createTestRenderer({ width: 100, height: 24 });
    const { bridge, emit } = makeBridge();
    createRoot(renderer).render(<App bridge={bridge} />);
    await settle();
    await flush();
    await renderOnce();

    // The screen coalesces host events on a ~frame tick before touching React,
    // then React commits asynchronously — settle covers both hops.
    emit({ kind: "reload", ok: true, durationMs: 312, functions: 12, at: Date.now() });
    emit({ kind: "reload", ok: false, message: "SyntaxError in messages.ts", at: Date.now() });
    await settle();
    await flush();
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame).toContain("reload");
    expect(frame).toContain("312ms");
    expect(frame).toContain("12 functions");
    expect(frame).toContain("SyntaxError");
    expect(frame).not.toMatch(/waiting/i); // empty state replaced by real activity

    renderer.destroy();
  });
});
