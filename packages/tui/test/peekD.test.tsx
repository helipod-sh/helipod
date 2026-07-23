/* @jsxImportSource @opentui/react */
import { test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
const settle = (ms = 320) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const logs: any[] = [];
// app traffic
for (let i = 0; i < 120; i++) logs.push({ id: i, path: "messages:send", kind: "mutation", ts: now - i * 3000, durationMs: 2, status: "ok" });
for (let i = 0; i < 60; i++) logs.push({ id: 500 + i, path: "messages:list", kind: "query", ts: now - i * 5000, durationMs: 1, status: "ok" });
// the dashboard observing itself
for (let i = 0; i < 200; i++) logs.push({ id: 2000 + i, path: "_admin:browseTable", kind: "query", ts: now - i * 2500, durationMs: 1, status: "ok" });
const bridge = {
  deployment: { url: "http://127.0.0.1:3210", dashboardUrl: "x", adminKeyPreview: "k…1",
    functionsDir: "helipod", storage: "sqlite", version: "0.1.4" },
  counts: () => ({ functions: 11, tables: 5, components: 1 }),
  onEvent: () => () => {}, requestQuit: () => {},
  data: { listTables: async () => [], getTableData: async () => ({ documents: [], cursor: null, isDone: true }),
    listFunctions: () => [], runFunction: async () => ({ value: null, committed: true }),
    onCommit: () => () => {}, stats: () => ({ connections: 2, subscriptions: 7, uptimeMs: 2.5e6 }),
    queryLogs: () => logs, schema: () => ({ tables: {} }) },
} as any;
test("peek", async () => {
  const r = await createTestRenderer({ width: 118, height: 34 });
  createRoot(r.renderer).render(<App bridge={bridge} />);
  await settle(150); await r.flush(); await r.renderOnce();
  await settle(400); await r.flush(); await r.renderOnce();
  const f = r.captureCharFrame();
  console.log(`=====OUT=====\n${f}=====END=====`);
  r.renderer.destroy();
});
