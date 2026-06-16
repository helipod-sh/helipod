// packages/sync/test/auth-identity.test.ts
import { describe, it, expect } from "vitest";
import type { Value, JSONValue } from "@stackbase/values";
import { SyncProtocolHandler, type SyncUdfExecutor, type SyncWebSocket } from "../src/handler";

function mockSocket(): SyncWebSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} };
}

// records the identity each runQuery is called with; returns a value derived from it
class RecordingExecutor implements SyncUdfExecutor {
  calls: Array<{ path: string; identity: string | null | undefined }> = [];
  async runQuery(path: string, _args: JSONValue, identity?: string | null) {
    this.calls.push({ path, identity });
    return { value: (identity ?? "anon") as unknown as Value, tables: ["t"], readRanges: [], globalTables: [] };
  }
  async runMutation(_p: string, _a: JSONValue, _i?: string | null) {
    return { value: null as unknown as Value, tables: [], writeRanges: [], commitTs: 1 };
  }
  async runAdminQuery(_p: string, _a: JSONValue) {
    throw new Error("admin modules not configured");
    return { value: null as unknown as Value, tables: [], readRanges: [], globalTables: [] };
  }
  async runAction(path: string) {
    return { value: `acted:${path}` as unknown as Value };
  }
}

describe("sync: per-session identity", () => {
  it("threads SetAuth identity into runQuery for new subscriptions", async () => {
    const ex = new RecordingExecutor();
    const h = new SyncProtocolHandler(ex);
    const sock = mockSocket();
    h.connect("s1", sock);
    await h.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: "tok-1" }));
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "me:get", args: {} }], remove: [] }));
    expect(ex.calls.at(-1)).toEqual({ path: "me:get", identity: "tok-1" });
  });

  it("re-runs existing subscriptions when SetAuth changes identity", async () => {
    const ex = new RecordingExecutor();
    const h = new SyncProtocolHandler(ex);
    const sock = mockSocket();
    h.connect("s1", sock);
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "me:get", args: {} }], remove: [] }));
    expect(ex.calls.at(-1)!.identity).toBeNull(); // anonymous first
    await h.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: "tok-2" }));
    expect(ex.calls.at(-1)).toEqual({ path: "me:get", identity: "tok-2" }); // re-ran under new identity
    // and a Transition was pushed for the re-run
    expect(sock.sent.some((m) => (m as { type: string }).type === "Transition")).toBe(true);
  });
});
