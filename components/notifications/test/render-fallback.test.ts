import { describe, it, expect } from "vitest";
import { resolveNotificationsConfig } from "../src/config";
import { deliverOutbound } from "../src/render";
import { NotificationSendError, type EmailProvider } from "../src/provider";

function scripted(behavior: "ok" | "retryable" | "permanent", label?: string): EmailProvider {
  return {
    channel: "email",
    name: label,
    async send() {
      if (behavior === "ok") return { providerMessageId: `id-${label ?? "x"}` };
      if (behavior === "permanent") throw new NotificationSendError("bad recipient", { retryable: false });
      throw new Error("transient 503");
    },
  };
}

function configWith(provider: EmailProvider, fallbacks: EmailProvider[]) {
  return resolveNotificationsConfig({ channels: { email: { provider, from: "no-reply@test", fallbacks } } });
}

describe("deliverOutbound — provider-list fallback", () => {
  it("succeeds via a later provider after an earlier retryable failure", async () => {
    const config = configWith(scripted("retryable", "primary"), [scripted("ok", "fallback-1")]);
    const res = await deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } });
    expect(res).toMatchObject({ providerMessageId: "id-fallback-1", providerName: "fallback-1" });
  });

  it("does NOT stop on a middle non-retryable failure — keeps walking to the next provider", async () => {
    const config = configWith(scripted("permanent", "primary"), [scripted("ok", "fallback-1")]);
    const res = await deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } });
    expect(res.providerName).toBe("fallback-1");
  });

  it("all-fail [5xx, 4xx] → overall retryable:true", async () => {
    const config = configWith(scripted("retryable", "primary"), [scripted("permanent", "fallback-1")]);
    await expect(deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } }))
      .rejects.toMatchObject({ retryable: true });
  });

  it("all-fail [4xx, 4xx] → overall retryable:false", async () => {
    const config = configWith(scripted("permanent", "primary"), [scripted("permanent", "fallback-1")]);
    await expect(deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } }))
      .rejects.toMatchObject({ retryable: false });
  });

  it("a single-provider list (no fallbacks) is unchanged: success labeled 'primary', failure throws as before", async () => {
    const config = configWith(scripted("ok", "primary"), []);
    const res = await deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } });
    expect(res).toMatchObject({ providerName: "primary" });

    const configFail = configWith(scripted("permanent"), []); // no .name set → defaults to "primary"
    await expect(deliverOutbound(configFail, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } }))
      .rejects.toThrow(/bad recipient/);
  });

  it("zero-behavior-change: a single-provider failure re-throws the provider's OWN error VERBATIM — no '[primary]' wrapping, class and message and retryable byte-identical to the pre-fallback path", async () => {
    // NotificationSendError (permanent) — the exact object the provider threw must propagate.
    const permanent = configWith(scripted("permanent"), []);
    const err = await deliverOutbound(permanent, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(NotificationSendError);
    expect(err.message).toBe("bad recipient");          // NOT "[primary] Error: bad recipient"
    expect(err.message).not.toMatch(/\[primary\]/);
    expect(err.retryable).toBe(false);

    // A plain Error (retryable path) is likewise re-thrown verbatim, not re-wrapped.
    const transient = configWith(scripted("retryable"), []);
    const err2 = await deliverOutbound(transient, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } })
      .then(() => null, (e) => e);
    expect(err2.message).toBe("transient 503");
    expect(err2.message).not.toMatch(/\[primary\]/);
  });
});
