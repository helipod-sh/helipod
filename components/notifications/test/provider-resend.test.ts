import { describe, it, expect, vi, afterEach } from "vitest";
import { resendEmail } from "../src/provider-resend";

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, json: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => "err-body", json: async () => json } as unknown as Response;
  }));
  return { calls };
}

describe("resendEmail", () => {
  it("POSTs to /emails with auth, JSON body, and returns the provider id", async () => {
    const { calls } = mockFetch(200, { id: "re_123" });
    const res = await resendEmail({ apiKey: "KEY" }).send({ to: "a@b.test", from: "x@y", subject: "S", text: "T", html: "<b>T</b>" });
    expect(res).toEqual({ providerMessageId: "re_123" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer KEY");
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ from: "x@y", to: "a@b.test", subject: "S", text: "T", html: "<b>T</b>" });
  });

  it("passes idempotencyKey through as the Idempotency-Key header", async () => {
    const { calls } = mockFetch(200, { id: "re_9" });
    await resendEmail({ apiKey: "KEY" }).send({ to: "a@b.test", from: "x@y", subject: "S", text: "T", idempotencyKey: "otp-42" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("otp-42");
  });

  it("throws on non-2xx", async () => {
    mockFetch(422, { message: "bad" });
    await expect(resendEmail({ apiKey: "KEY" }).send({ to: "a@b", from: "x@y", subject: "S", text: "T" })).rejects.toThrow(/resend send failed \(422\)/);
  });
});
