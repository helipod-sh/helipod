/* @jsxImportSource @opentui/react */
/**
 * Regression: the data browser must open on an app table that has rows.
 *
 * Table names sort with `_`-prefixed internals first, so the screen used to open
 * on `_storage` (0 rows) and render "(empty table)" — it looked broken on every
 * fresh project.
 */
import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const bridge = {
  deployment: {
    url: "http://127.0.0.1:3210",
    dashboardUrl: null,
    adminKeyPreview: "k…1",
    functionsDir: "helipod",
    storage: "sqlite",
    version: "0.1.4",
  },
  counts: () => ({ functions: 4, tables: 5, components: 1 }),
  onEvent: () => () => {},
  requestQuit: () => {},
  data: {
    // Deliberately in the order listTables() returns them: internals first.
    listTables: async () => [
      { name: "_storage", documentCount: 0, indexes: [] },
      { name: "auditLog", documentCount: 4, indexes: [] },
      { name: "conversations", documentCount: 0, indexes: [] },
      { name: "messages", documentCount: 4, indexes: [] },
      { name: "triggers/cursors", documentCount: 1, indexes: [] },
    ],
    getTableData: async () => ({
      documents: [
        { _id: "a1", actor: "ada", event: "created" },
        { _id: "a2", actor: "grace", event: "updated" },
      ],
      cursor: null,
      isDone: true,
    }),
    listFunctions: () => [],
    runFunction: async () => ({ value: null, committed: false }),
    queryLogs: () => [],
    schema: () => ({ tables: {} }),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

test("opens on an app table with rows, groups internals under 'system'", async () => {
  const { renderer, renderOnce, flush, captureCharFrame, mockInput } = await createTestRenderer({
    width: 100,
    height: 20,
  });
  createRoot(renderer).render(<App bridge={bridge} />);
  await settle(120);
  await flush();
  await renderOnce();
  mockInput.pressKey("2");
  await settle(300);
  await flush();
  await renderOnce();

  const frame = captureCharFrame();
  // Landed on auditLog (the first app table with rows) — not _storage.
  expect(frame).toContain("auditLog");
  expect(frame).not.toContain("no documents in");
  // Rows actually rendered.
  expect(frame).toContain("ada");
  // Internals are grouped, not interleaved at the top.
  expect(frame).toContain("app");
  expect(frame).toContain("system");
  const appRow = frame.indexOf("app");
  const systemRow = frame.indexOf("system");
  expect(appRow).toBeLessThan(systemRow);

  renderer.destroy();
});
