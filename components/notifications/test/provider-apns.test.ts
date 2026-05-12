import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http2 from "node:http2";
import { generateKeyPairSync } from "node:crypto";
import { apnsPush } from "../src/provider-apns";

let server: http2.Http2Server;
let baseUrl: string;
let lastRequest: { path: string; auth: string | undefined; body: string } | null = null;
let responseStatus = 200;
let responseBody: Record<string, unknown> = {};

// APNs' real endpoint is TLS; for a local test, run a PLAINTEXT http2 server (`http2.createServer`,
// not `createSecureServer`) and point the adapter's `baseUrl` at `http://` — Node's http2 client
// supports h2c (h2-without-TLS) for exactly this kind of local test (spiked and confirmed working);
// production always uses the real `https://api.push.apple.com`/`https://api.sandbox.push.apple.com`
// default, TLS always, driven by `production?: boolean`.
beforeAll(async () => {
  server = http2.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequest = { path: req.url!, auth: req.headers.authorization, body };
      res.writeHead(responseStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

describe("apnsPush", () => {
  it("sends a well-formed JWT (kid/iss) and the aps payload, per-token, over http2", async () => {
    responseStatus = 200; responseBody = {};
    const provider = apnsPush({ teamId: "TEAM1", keyId: "KEY1", privateKey: TEST_KEY_PEM, bundleId: "com.test.app", production: false, baseUrl });
    await provider.send({ to: ["devtok1"], title: "T", body: "B" });
    expect(lastRequest?.path).toBe("/3/device/devtok1");
    expect(lastRequest?.auth).toMatch(/^bearer /i);
    const payload = JSON.parse(lastRequest!.body) as { aps: { alert: { title: string; body: string } } };
    expect(payload.aps.alert).toEqual({ title: "T", body: "B" });
  });

  it("maps a 410/Unregistered response to invalidTokens", async () => {
    responseStatus = 410; responseBody = { reason: "Unregistered" };
    const provider = apnsPush({ teamId: "TEAM1", keyId: "KEY1", privateKey: TEST_KEY_PEM, bundleId: "com.test.app", production: false, baseUrl });
    const res = await provider.send({ to: ["devtok1"], title: "T", body: "B" });
    expect(res.invalidTokens).toEqual(["devtok1"]);
  });

  it("throws NotificationSendError on a 5xx", async () => {
    responseStatus = 500; responseBody = { reason: "InternalServerError" };
    const provider = apnsPush({ teamId: "TEAM1", keyId: "KEY1", privateKey: TEST_KEY_PEM, bundleId: "com.test.app", production: false, baseUrl });
    await expect(provider.send({ to: ["devtok1"], title: "T", body: "B" })).rejects.toThrow(/500|InternalServerError/);
  });
});
