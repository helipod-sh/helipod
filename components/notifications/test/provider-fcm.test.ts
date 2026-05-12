import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { fcmPush } from "../src/provider-fcm";

// A real (test-only, throwaway) RSA keypair — jose's SignJWT needs a genuinely importable PKCS8 key
// to construct a well-formed JWT even against a mocked token endpoint; a placeholder string would
// be rejected before any fetch happens.
let TEST_PRIVATE_KEY_PEM: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  TEST_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
});

function serviceAccount(): { client_email: string; private_key: string } {
  return { client_email: "svc@test.iam.gserviceaccount.com", private_key: TEST_PRIVATE_KEY_PEM };
}

describe("fcmPush", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges the service-account JWT for an access token, then sends one request per token", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "AT1", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ name: "projects/p/messages/1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = fcmPush({ projectId: "p", serviceAccount: serviceAccount() });
    await provider.send({ to: ["fcmtok1", "fcmtok2"], title: "T", body: "B" });
    expect(calls.filter((u) => u.includes("messages:send"))).toHaveLength(2); // one request PER token
  });

  it("caches the access token across sends within its lifetime", async () => {
    const tokenCalls = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT1", expires_in: 3600 }), { status: 200 }));
    const fetchMock = vi.fn(async (url: string) => (url.includes("oauth2.googleapis.com") ? tokenCalls() : new Response(JSON.stringify({}), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = fcmPush({ projectId: "p", serviceAccount: serviceAccount() });
    await provider.send({ to: ["a"], title: "T", body: "B" });
    await provider.send({ to: ["b"], title: "T", body: "B" });
    expect(tokenCalls).toHaveBeenCalledTimes(1); // second send reuses the cached token
  });

  it("maps UNREGISTERED to invalidTokens without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "AT1", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: { status: "UNREGISTERED" } }), { status: 404 }))));
    const provider = fcmPush({ projectId: "p", serviceAccount: serviceAccount() });
    const res = await provider.send({ to: ["dead"], title: "T", body: "B" });
    expect(res.invalidTokens).toEqual(["dead"]);
  });
});
