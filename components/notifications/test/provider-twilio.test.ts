import { describe, it, expect, vi, afterEach } from "vitest";
import { twilioSms } from "../src/provider-twilio";

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, json: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => "err", json: async () => json } as unknown as Response;
  }));
  return { calls };
}

describe("twilioSms", () => {
  it("POSTs form-encoded to the Messages endpoint with Basic auth and returns the sid", async () => {
    const { calls } = mockFetch(201, { sid: "SM123" });
    const res = await twilioSms({ accountSid: "AC1", authToken: "tok" }).send({ to: "+1555", from: "+1999", body: "hi" });
    expect(res).toEqual({ providerMessageId: "SM123" });
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("To")).toBe("+1555");
    expect(form.get("From")).toBe("+1999");
    expect(form.get("Body")).toBe("hi");
  });

  it("prefixes whatsapp: on both To and From for kind:whatsapp", async () => {
    const { calls } = mockFetch(201, { sid: "SM9" });
    await twilioSms({ accountSid: "AC1", authToken: "tok" }).send({ to: "+1555", from: "+1999", body: "hi", kind: "whatsapp" });
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("To")).toBe("whatsapp:+1555");
    expect(form.get("From")).toBe("whatsapp:+1999");
  });

  it("throws on non-2xx", async () => {
    mockFetch(400, { message: "bad" });
    await expect(twilioSms({ accountSid: "AC1", authToken: "tok" }).send({ to: "+1", from: "+2", body: "x" })).rejects.toThrow(/twilio send failed \(400\)/);
  });
});
