import { describe, it, expect } from "vitest";
import { SyncProtocolHandler, type SyncUdfExecutor } from "../src/index";

function mkExec(): SyncUdfExecutor & { adminCalls: string[] } {
  const adminCalls: string[] = [];
  return {
    adminCalls,
    async runQuery(path) { return { value: `user:${path}` as never, tables: ["t"], readRanges: [] }; },
    async runMutation() { return { value: null as never, tables: [], writeRanges: [], commitTs: 1 }; },
    async runAdminQuery(path) { adminCalls.push(path); return { value: `admin:${path}` as never, tables: ["t"], readRanges: [] }; },
  };
}
function sock() { const sent: any[] = []; return { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} }; }
const mods = (s: { sent: any[] }) => s.sent.flatMap((m) => m.modifications ?? []);

describe("admin sync channel", () => {
  it("a non-admin session subscribing to _admin:* is rejected (QueryFailed), no admin run", async () => {
    const ex = mkExec();
    const h = new SyncProtocolHandler(ex, { verifyAdmin: (k) => k === "SECRET" });
    const s = sock(); h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: {} }], remove: [] }));
    expect(mods(s).find((m: any) => m.queryId === 1)?.type).toBe("QueryFailed");
    expect(ex.adminCalls).toEqual([]);
  });

  it("after SetAdminAuth with the right key, _admin:* runs privileged", async () => {
    const ex = mkExec();
    const h = new SyncProtocolHandler(ex, { verifyAdmin: (k) => k === "SECRET" });
    const s = sock(); h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "SetAdminAuth", key: "SECRET" }));
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: {} }], remove: [] }));
    expect(ex.adminCalls).toEqual(["_admin:browseTable"]);
    const upd = mods(s).find((m: any) => m.type === "QueryUpdated" && m.queryId === 1);
    expect(upd?.value).toBe("admin:_admin:browseTable");
  });

  it("a wrong key does NOT privilege the session", async () => {
    const ex = mkExec();
    const h = new SyncProtocolHandler(ex, { verifyAdmin: (k) => k === "SECRET" });
    const s = sock(); h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "SetAdminAuth", key: "WRONG" }));
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: {} }], remove: [] }));
    expect(mods(s).find((m: any) => m.queryId === 1)?.type).toBe("QueryFailed");
    expect(ex.adminCalls).toEqual([]);
  });
});
