import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { resendEmail } from "../src/provider-resend";

const SECRET = "whsec_" + Buffer.from("test-signing-key-0123456789").toString("base64");
function sign(id: string, ts: string, body: string): string {
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}
function headers(id: string, ts: string, sig: string): Headers {
  return new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });
}

describe("resendEmail.webhook (Svix)", () => {
  const wh = resendEmail({ apiKey: "K" }).webhook!;
  const now = () => Math.floor(Date.now() / 1000); // current ts (seconds) — verify checks against real wall clock

  it("verifies a correctly-signed payload", async () => {
    const id = "msg_1", ts = String(now());
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    const ok = await wh.verify({ headers: headers(id, ts, sign(id, ts, body)), rawBody: body, url: "https://x/api/notifications/webhooks/email", secret: SECRET });
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const id = "msg_1", ts = String(now());
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    const sig = sign(id, ts, body);
    const ok = await wh.verify({ headers: headers(id, ts, sig), rawBody: body + "X", url: "https://x", secret: SECRET });
    expect(ok).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", async () => {
    const id = "msg_1", ts = String(now() - 60 * 60); // 1h old
    const body = "{}";
    const ok = await wh.verify({ headers: headers(id, ts, sign(id, ts, body)), rawBody: body, url: "https://x", secret: SECRET });
    expect(ok).toBe(false);
  });

  it("parses Resend event types to normalized DeliveryStatus", () => {
    const evs = wh.parse(JSON.stringify({ type: "email.bounced", data: { email_id: "re_9" } }));
    expect(evs).toEqual([{ providerMessageId: "re_9", deliveryStatus: "bounced" }]);
    expect(wh.parse(JSON.stringify({ type: "email.opened", data: { email_id: "re_2" } }))[0]!.deliveryStatus).toBe("opened");
    expect(wh.parse(JSON.stringify({ type: "email.complained", data: { email_id: "re_3" } }))[0]!.deliveryStatus).toBe("complained");
  });
});
