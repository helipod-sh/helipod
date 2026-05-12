import { describe, it, expect, vi, afterEach } from "vitest";
import { expoPush } from "../src/provider-expo";
import { NotificationSendError } from "../src/provider";

describe("expoPush", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a batch of messages in one POST, parses tickets into invalidTokens", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ status: "ok", id: "receipt1" }, { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = expoPush();
    const res = await provider.send({ to: ["ExponentPushToken[a]", "ExponentPushToken[b]"], title: "T", body: "B" });
    expect(res.invalidTokens).toEqual(["ExponentPushToken[b]"]);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Array<{ to: string }>;
    expect(body).toHaveLength(2);
  });

  it("chunks a batch larger than 100 into multiple requests", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: Array(100).fill({ status: "ok" }) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = expoPush();
    const tokens = Array.from({ length: 150 }, (_, i) => `tok${i}`);
    await provider.send({ to: tokens, title: "T", body: "B" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 100 + 50
  });

  it("throws NotificationSendError on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(expoPush().send({ to: ["t"], title: "T", body: "B" })).rejects.toThrow(NotificationSendError);
  });
});
