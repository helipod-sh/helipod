/* @jsxImportSource @opentui/react */
/**
 * The three interactive surfaces: row inspection, filtering, and the command
 * palette. Each is driven through real key events against the real render tree.
 */
import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

let lastFilter: unknown = null;

function makeBridge() {
  lastFilter = null;
  return {
    deployment: {
      url: "http://127.0.0.1:3210",
      dashboardUrl: null,
      adminKeyPreview: "k…1",
      functionsDir: "helipod",
      storage: "sqlite",
      version: "0.1.4",
    },
    counts: () => ({ functions: 2, tables: 2, components: 0 }),
    onEvent: () => () => {},
    requestQuit: () => {},
    data: {
      listTables: async () => [
        { name: "messages", documentCount: 2, indexes: [] },
        { name: "conversations", documentCount: 1, indexes: [] },
      ],
      getTableData: async (_t: string, o?: { filter?: unknown }) => {
        lastFilter = o?.filter ?? null;
        return {
          documents: [
            { _id: "m1", author: "ada", body: "first message here" },
            { _id: "m2", author: "grace", body: "second message here" },
          ],
          cursor: null,
          isDone: true,
        };
      },
      listFunctions: () => [{ path: "messages:send", kind: "mutation" }],
      runFunction: async () => ({ value: null, committed: true }),
      queryLogs: () => [],
      schema: () => ({ tables: {} }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function boot(width = 110, height = 24) {
  const r = await createTestRenderer({ width, height });
  createRoot(r.renderer).render(<App bridge={makeBridge()} />);
  await settle(120);
  await r.flush();
  await r.renderOnce();
  return r;
}

async function step(r: Awaited<ReturnType<typeof boot>>, ms = 220) {
  await settle(ms);
  await r.flush();
  await r.renderOnce();
}

test("⏎ inspects the selected row, J/K moves it, esc closes", async () => {
  const r = await boot();
  r.mockInput.pressKey("2");
  await step(r);

  r.mockInput.pressEnter();
  await step(r);
  let frame = r.captureCharFrame();
  expect(frame).toContain("document 1/2");
  expect(frame).toContain("first message here");

  r.mockInput.pressKey("J");
  await step(r);
  frame = r.captureCharFrame();
  expect(frame).toContain("document 2/2");
  expect(frame).toContain("grace");

  r.mockInput.pressEscape();
  await step(r);
  expect(r.captureCharFrame()).not.toContain("document 2/2");
  r.renderer.destroy();
});

test("f enters a filter and ⏎ sends it to the server as an equality condition", async () => {
  const r = await boot();
  r.mockInput.pressKey("2");
  await step(r);

  r.mockInput.pressKey("f");
  await step(r, 120);
  r.mockInput.typeText("author=ada");
  await step(r, 120);
  expect(r.captureCharFrame()).toContain("filter: author=ada");

  r.mockInput.pressEnter();
  await step(r);
  expect(lastFilter).toEqual([{ field: "author", op: "eq", value: "ada" }]);
  r.renderer.destroy();
});

test(": opens the palette, fuzzy-matches, and ⏎ jumps to the chosen table", async () => {
  const r = await boot();
  r.mockInput.typeText(":");
  await step(r, 150);
  expect(r.captureCharFrame()).toContain("screen");

  r.mockInput.typeText("conv");
  await step(r, 150);
  const frame = r.captureCharFrame();
  expect(frame).toContain("conversations");

  r.mockInput.pressEnter();
  await step(r);
  const after = r.captureCharFrame();
  expect(after).not.toContain(" ⏎ go · esc cancel"); // palette closed
  expect(after).toContain("conversations");
  r.renderer.destroy();
});
