import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { twilioSms } from "../src/provider-twilio";

const TOKEN = "test_auth_token";
const URL_ = "https://app.test/api/notifications/webhooks/sms";

function twilioSign(url: string, params: Record<string, string>): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac("sha1", TOKEN).update(data).digest("base64");
}
function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

describe("twilioSms.webhook (X-Twilio-Signature)", () => {
  const wh = twilioSms({ accountSid: "AC1", authToken: TOKEN }).webhook!;

  it("verifies a correctly-signed status callback", async () => {
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const sig = twilioSign(URL_, params);
    const ok = await wh.verify({ headers: new Headers({ "x-twilio-signature": sig }), rawBody: form(params), url: URL_, secret: undefined });
    expect(ok).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const ok = await wh.verify({ headers: new Headers({ "x-twilio-signature": "wrong" }), rawBody: form(params), url: URL_, secret: undefined });
    expect(ok).toBe(false);
  });

  it("parses MessageStatus to normalized DeliveryStatus", () => {
    expect(wh.parse(form({ MessageSid: "SM1", MessageStatus: "delivered" }))).toEqual([{ providerMessageId: "SM1", deliveryStatus: "delivered" }]);
    expect(wh.parse(form({ MessageSid: "SM2", MessageStatus: "undelivered" }))[0]!.deliveryStatus).toBe("bounced");
    expect(wh.parse(form({ MessageSid: "SM3", MessageStatus: "failed" }))[0]!.deliveryStatus).toBe("failed_permanent");
    expect(wh.parse(form({ MessageSid: "SM4", MessageStatus: "sent" }))).toEqual([]); // non-terminal → ignored
  });
});
