/* @jsxImportSource @opentui/react */
/**
 * The dashboard must be a reactive client of its own engine: a committed write
 * repaints the visible table without any user action and without polling.
 */
import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test("a commit to the visible table repaints it live", async () => {
  const listeners = new Set<(t: string[], ts: number) => void>();
  let rows = [{ _id: "m1", author: "ada", body: "first message" }];
  let count = 1;

  const bridge = {
    deployment: {
      url: "http://127.0.0.1:3210",
      dashboardUrl: null,
      adminKeyPreview: "k…1",
      functionsDir: "helipod",
      storage: "sqlite",
      version: "0.1.4",
    },
    counts: () => ({ functions: 1, tables: 1, components: 0 }),
    onEvent: () => () => {},
    requestQuit: () => {},
    data: {
      listTables: async () => [{ name: "messages", documentCount: count, indexes: [] }],
      getTableData: async () => ({ documents: rows, cursor: null, isDone: true }),
      listFunctions: () => [],
      runFunction: async () => ({ value: null, committed: true }),
      queryLogs: () => [],
      schema: () => ({ tables: {} }),
      onCommit: (cb: (t: string[], ts: number) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const r = await createTestRenderer({ width: 100, height: 20 });
  createRoot(r.renderer).render(<App bridge={bridge} />);
  await settle(120);
  await r.flush();
  await r.renderOnce();
  r.mockInput.pressKey("2");
  await settle();
  await r.flush();
  await r.renderOnce();

  expect(r.captureCharFrame()).toContain("first message");
  expect(r.captureCharFrame()).not.toContain("second message");

  // A mutation commits, touching `messages` — no key press, no refresh.
  rows = [...rows, { _id: "m2", author: "grace", body: "second message" }];
  count = 2;
  for (const cb of listeners) cb(["messages"], 42);

  await settle(300);
  await r.flush();
  await r.renderOnce();

  const frame = r.captureCharFrame();
  expect(frame).toContain("second message"); // the new row appeared on its own
  expect(frame).toContain("2 rows"); // and the count updated
  r.renderer.destroy();
});
