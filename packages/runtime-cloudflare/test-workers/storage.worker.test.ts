/**
 * FILE STORAGE + COMPONENT (OAuth) ROUTES on a REAL Durable Object (workerd) — the highest fidelity
 * achievable without a Cloudflare login. `StorageDO extends StackbaseDurableObject` boots with an
 * R2-backed `BlobStore` (`@stackbase/blobstore-r2` over miniflare's in-memory R2 emulation bound as
 * `env.STORAGE_BUCKET`), proving end-to-end INSIDE a genuine DO:
 *   - `ctx.storage.generateUploadUrl` → a proxied upload target served by the DO's own `fetch`;
 *   - the proxied upload POSTs bytes → they land in R2 → the `_storage` row flips to `ready`;
 *   - `ctx.storage.getUrl` → a token-signed download url served by the DO → round-trips the bytes;
 *   - a `Range:` request returns the correct 206 partial;
 *   - a composed component's reserved `GET /api/authfixture/oauth/*` route dispatches (audit gap 8c).
 *
 * The one thing this does NOT cover (needs a real `wrangler deploy`, no Cloudflare login here): bytes
 * in a REAL R2 bucket across datacenters. See ./README for the human-run deploy E2E.
 *
 * NOT product code — a test. Safe to delete with this branch's tests.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

interface DoNs {
  idFromName(n: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response & { webSocket?: WebSocket }> };
}
const DO = () => (env as { STORAGE_DO: DoNs }).STORAGE_DO;
const stub = (name: string) => DO().get(DO().idFromName(name));
const ORIGIN = "https://do.test";

function post(path: string, bodyObj: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}
async function runValue<T>(s: ReturnType<typeof stub>, path: string, args: unknown): Promise<T> {
  const res = await s.fetch(post("/api/run", { path, args }));
  expect(res.status, `${path} should 200`).toBe(200);
  return (await res.json()).value as T;
}

interface UploadTarget { kind: string; url: string; method: string; headers?: Record<string, string> }

describe("file storage on a REAL DO (R2 blob store)", () => {
  it("generateUploadUrl → proxied upload → ready → getUrl download round-trips the bytes", async () => {
    const s = stub("roundtrip");
    const payload = new TextEncoder().encode("hello from an R2-backed durable object");

    // 1. Mint a proxied upload target (a mutation writing the pending `_storage` row).
    const { storageId, target } = await runValue<{ storageId: string; target: UploadTarget }>(
      s,
      "files:genUpload",
      { contentType: "text/plain" },
    );
    expect(typeof storageId).toBe("string");
    expect(target.kind).toBe("proxied");
    expect(target.url.startsWith("/api/storage/upload?")).toBe(true);

    // 2. Proxied upload: POST the bytes to the DO's own /api/storage/upload endpoint (served by the
    //    DO's fetch via the storage route the seam fix now dispatches). Bytes land in R2.
    const up = await s.fetch(
      new Request(`${ORIGIN}${target.url}`, { method: "POST", headers: { "content-type": "text/plain" }, body: payload }),
    );
    expect(up.status).toBe(200);
    expect((await up.json()).storageId).toBe(storageId);

    // 3. The `_storage` row is now `ready` with the right size/content-type.
    const meta = await runValue<{ size: number | null; contentType: string | null }>(s, "files:getMeta", { id: storageId });
    expect(meta).not.toBeNull();
    expect(meta.size).toBe(payload.byteLength);
    expect(meta.contentType).toBe("text/plain");

    // 4. getUrl → a token-signed private download url, also served by the DO.
    const url = await runValue<string | null>(s, "files:getUrl", { id: storageId });
    expect(url).not.toBeNull();
    expect(url!.startsWith("/api/storage/")).toBe(true);

    // 5. GET it → the exact bytes back out of R2, streamed through the DO.
    const dl = await s.fetch(new Request(`${ORIGIN}${url}`));
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(payload);
  });

  it("serves a Range request as a 206 partial", async () => {
    const s = stub("range");
    const payload = new TextEncoder().encode("0123456789ABCDEF");
    const { storageId, target } = await runValue<{ storageId: string; target: UploadTarget }>(s, "files:genUpload", {});
    await s.fetch(new Request(`${ORIGIN}${target.url}`, { method: "POST", body: payload }));
    const url = await runValue<string>(s, "files:getUrl", { id: storageId });
    const res = await s.fetch(new Request(`${ORIGIN}${url}`, { headers: { Range: "bytes=4-7" } }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 4-7/${payload.byteLength}`);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("4567");
  });

  it("a stored file's id saved into a user table survives a read-back", async () => {
    const s = stub("save");
    const payload = new TextEncoder().encode("saved bytes");
    const { storageId, target } = await runValue<{ storageId: string; target: UploadTarget }>(s, "files:genUpload", {});
    await s.fetch(new Request(`${ORIGIN}${target.url}`, { method: "POST", body: payload }));
    await runValue(s, "files:save", { name: "note.txt", storageId });
    const rows = await runValue<Array<{ name: string; image: string }>>(s, "files:list", {});
    expect(rows).toContainEqual({ name: "note.txt", image: storageId });
  });
});

describe("component (OAuth-style) routes dispatch on a REAL DO", () => {
  it("routes GET /api/authfixture/oauth/* to a composed component's httpAction (audit gap 8c)", async () => {
    const s = stub("oauth");
    const res = await s.fetch(new Request(`${ORIGIN}/api/authfixture/oauth/callback?code=xyz123`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; path: string };
    expect(body.ok).toBe(true);
    expect(body.code).toBe("xyz123");
    expect(body.path).toBe("/api/authfixture/oauth/callback");
  });
});
