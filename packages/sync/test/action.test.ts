import { describe, it, expect } from "vitest";
import { SyncProtocolHandler, type SyncUdfExecutor } from "../src/index";

function mkExec(runAction: SyncUdfExecutor["runAction"]): SyncUdfExecutor {
  return {
    async runQuery(path) { return { value: `user:${path}` as never, tables: ["t"], readRanges: [] }; },
    async runMutation() { return { value: null as never, tables: [], writeRanges: [], commitTs: 1 }; },
    async runAdminQuery(path) { return { value: `admin:${path}` as never, tables: ["t"], readRanges: [] }; },
    runAction,
  };
}
function sock() { const sent: any[] = []; return { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} }; }

describe("Action / ActionResponse", () => {
  it("handleAction runs the action and replies ActionResponse (no notifyWrites)", async () => {
    let notified = false;
    const ex = mkExec(async (path: string) => { return { value: `acted:${path}` as never }; });
    const h = new SyncProtocolHandler(ex, { verifyAdmin: () => false });
    const origNotify = h.notifyWrites.bind(h);
    h.notifyWrites = ((...args: Parameters<typeof origNotify>) => {
      notified = true;
      return origNotify(...args);
    }) as typeof h.notifyWrites;
    const sock1 = sock();
    h.connect("s1", sock1 as never);
    await h.handleMessage("s1", JSON.stringify({ type: "Action", requestId: "r1", udfPath: "app:act", args: {} }));
    const resp = sock1.sent.find((m) => m.type === "ActionResponse");
    expect(resp).toMatchObject({ requestId: "r1", success: true, value: "acted:app:act" });
    expect(notified).toBe(false);
  });

  it("handleAction replies with success:false when the executor throws", async () => {
    const ex = mkExec(async () => { throw new Error("boom"); });
    const h = new SyncProtocolHandler(ex, { verifyAdmin: () => false });
    const sock1 = sock();
    h.connect("s1", sock1 as never);
    await h.handleMessage("s1", JSON.stringify({ type: "Action", requestId: "r2", udfPath: "app:act", args: {} }));
    const resp = sock1.sent.find((m) => m.type === "ActionResponse");
    expect(resp).toMatchObject({ requestId: "r2", success: false, error: "boom" });
  });

  it("a client Action reaching an internal module is rejected (mirrors the gated public runAction)", async () => {
    const ex = mkExec(async (path: string) => {
      if (path.split(":").some((seg) => seg.startsWith("_"))) throw new Error(`unknown function: ${path}`);
      return { value: `acted:${path}` as never };
    });
    const h = new SyncProtocolHandler(ex, { verifyAdmin: () => false });
    const sock1 = sock();
    h.connect("s1", sock1 as never);
    await h.handleMessage("s1", JSON.stringify({ type: "Action", requestId: "r3", udfPath: "scheduler:_enqueue", args: {} }));
    const resp = sock1.sent.find((m) => m.type === "ActionResponse");
    expect(resp).toMatchObject({ requestId: "r3", success: false });
    expect(resp.error).toMatch(/unknown function/);
  });
});
