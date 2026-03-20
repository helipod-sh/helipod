import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { consoleEmail, resendEmail } from "../src/email/provider";
import { resolveTemplates, defaultTemplates } from "../src/email/templates";
import { makeAuthModules } from "../src/functions";
import { resolveAuthConfig } from "../src/config";

describe("resendEmail", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts to the Resend API with the expected shape (attribution: better-auth email-verification route test shape)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = resendEmail({ apiKey: "re_test_key" });
    await provider.send({ to: "a@b.co", from: "noreply@app.co", subject: "Hi", text: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ from: "noreply@app.co", to: "a@b.co", subject: "Hi", text: "hello" });
    expect(body.html).toBeUndefined();
  });

  it("includes html in the body only when provided", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = resendEmail({ apiKey: "re_test_key" });
    await provider.send({ to: "a@b.co", from: "noreply@app.co", subject: "Hi", text: "hello", html: "<p>hello</p>" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.html).toBe("<p>hello</p>");
  });

  it("rejects with the status + body on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("validation failed: to is required", { status: 422 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = resendEmail({ apiKey: "re_test_key" });
    await expect(
      provider.send({ to: "a@b.co", from: "noreply@app.co", subject: "Hi", text: "hello" }),
    ).rejects.toThrow(/422/);
    await expect(
      provider.send({ to: "a@b.co", from: "noreply@app.co", subject: "Hi", text: "hello" }),
    ).rejects.toThrow(/validation failed/);
  });

  it("honors a custom baseUrl", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = resendEmail({ apiKey: "re_test_key", baseUrl: "https://my-resend-proxy.internal" });
    await provider.send({ to: "a@b.co", from: "noreply@app.co", subject: "Hi", text: "hello" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://my-resend-proxy.internal/emails");
  });
});

describe("consoleEmail", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("logs the full email including the raw code/link (dev convenience is deliberate)", async () => {
    const provider = consoleEmail();
    await provider.send({
      to: "a@b.co",
      from: "noreply@app.co",
      subject: "Your sign-in code",
      text: "Your code is: 12345678",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("a@b.co");
    expect(output).toContain("Your sign-in code");
    expect(output).toContain("12345678");
  });
});

describe("resolveTemplates", () => {
  it("a partial override replaces only that flow; others keep defaults", () => {
    const custom = resolveTemplates({
      otp: () => ({ subject: "custom subject", text: "custom text" }),
    });

    expect(custom.otp).not.toBe(defaultTemplates.otp);
    expect(custom.otp({ appName: "App", email: "a@b.co", code: "1", ttlMs: 1000 })).toEqual({
      subject: "custom subject",
      text: "custom text",
    });

    // Others fall through to the shipped defaults, unaffected.
    expect(custom.verify).toBe(defaultTemplates.verify);
    expect(custom.reset).toBe(defaultTemplates.reset);
    expect(custom.magic).toBe(defaultTemplates.magic);
  });

  it("with no overrides, resolves to exactly the defaults", () => {
    expect(resolveTemplates()).toEqual(defaultTemplates);
  });
});

describe("surface-unchanged guarantee (email config absent)", () => {
  it("makeAuthModules(resolveAuthConfig()) has EXACTLY the A1 keys — no A2 functions registered", () => {
    const modules = makeAuthModules(resolveAuthConfig());
    const keys = Object.keys(modules).sort();
    expect(keys).toEqual(
      [
        "signUp",
        "signIn",
        "signOut",
        "getUserId",
        "refresh",
        "signInAnonymously",
        "listSessions",
        "revokeSession",
        "revokeOtherSessions",
      ].sort(),
    );
    expect(modules.requestOtp).toBeUndefined();
    expect(modules.verifyEmail).toBeUndefined();
    expect((modules as Record<string, unknown>)._issueCode).toBeUndefined();
  });
});
