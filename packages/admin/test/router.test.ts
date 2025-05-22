// packages/admin/test/router.test.ts
import { describe, it, expect } from "vitest";
import { handleAdminRequest } from "../src/router";

// Minimal fake AdminApi — the router only forwards to these methods.
const api: any = {
  listTables: async () => [{ name: "notes", indexes: [], documentCount: 0 }],
  getTableData: async (_t: string, o: any) => ({ documents: [], total: 0, page: o.page ?? 0, pageSize: o.pageSize ?? 50 }),
  listFunctions: () => [{ path: "notes:list", kind: "query" }],
  queryLogs: () => [],
  runFunction: async () => ({ value: 1, committed: true }),
  patchDocument: async (_id: string, f: any) => ({ ...f, _id }),
  deleteDocument: async () => undefined,
  createDocument: async (_t: string, f: any) => ({ ...f, _id: "new" }),
};
const KEY = "secret";
const auth = { authorization: `Bearer ${KEY}` };

describe("handleAdminRequest", () => {
  it("rejects missing/wrong key with 401", async () => {
    const r = await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/tables", query: {} });
    expect(r.status).toBe(401);
  });

  it("routes tables, data, functions, run, logs", async () => {
    expect((await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/tables", query: {}, ...auth })).status).toBe(200);
    expect((await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/tables/notes/data", query: { pageSize: "10" }, ...auth })).status).toBe(200);
    expect((await handleAdminRequest(api, KEY, { method: "POST", path: "/_admin/run", query: {}, body: JSON.stringify({ path: "notes:list", args: {} }), ...auth })).status).toBe(200);
    const logs = await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/logs", query: {}, ...auth });
    expect(logs.status).toBe(200);
  });

  it("routes create / patch / delete on docs", async () => {
    expect((await handleAdminRequest(api, KEY, { method: "POST", path: "/_admin/tables/notes/docs", query: {}, body: JSON.stringify({ title: "x" }), ...auth })).status).toBe(200);
    expect((await handleAdminRequest(api, KEY, { method: "PATCH", path: "/_admin/tables/notes/docs/abc", query: {}, body: JSON.stringify({ title: "y" }), ...auth })).status).toBe(200);
    expect((await handleAdminRequest(api, KEY, { method: "DELETE", path: "/_admin/tables/notes/docs/abc", query: {}, ...auth })).status).toBe(200);
  });

  it("404s an unknown admin route", async () => {
    const r = await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/nope", query: {}, ...auth });
    expect(r.status).toBe(404);
  });
});
