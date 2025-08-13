import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import type {
  BlobStore,
  UploadTarget,
  StoredBlob,
  ByteRange,
  CreateUploadTargetOpts,
  SignUrlOpts,
} from "@stackbase/blobstore";
import { STORAGE_TABLE, STORAGE_TABLE_NUMBER, storageTableDefinition } from "../src/system-table";
import { storageModules } from "../src/modules";
import { storageContextProvider } from "../src/context";
import { createStorageToken, type TokenScope } from "../src/token";
import { storageRoutes, type StorageRoute, type StorageRouteDeps } from "../src/http";

const SIGNING_KEY = "test-signing-key";

/**
 * A minimal in-file `BlobStore` fake, mirroring `test/context.test.ts`'s `FakeBlobStore` (the real
 * `MemoryBlobStore` in `@stackbase/blobstore`'s test-support isn't a published export). `blobs` is
 * exposed directly so tests can assert on stored bytes / simulate a "direct" upload landing
 * out-of-band (the confirm-endpoint scenario).
 */
async function toBytes(bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (bytes instanceof Uint8Array) return bytes;
  const chunks: Uint8Array[] = [];
  const reader = bytes.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

class FakeBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  /** Counts `read()` calls — lets access-control tests assert bytes are never touched on a denial. */
  readCalls = 0;

  async createUploadTarget(key: string, _opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    return { kind: "proxied", url: `/api/storage/upload?id=${encodeURIComponent(key)}`, method: "POST" };
  }
  async store(key: string, bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<StoredBlob> {
    const buf = await toBytes(bytes);
    this.blobs.set(key, buf);
    return { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
  }
  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    const buf = this.blobs.get(key);
    return buf ? { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") } : null;
  }
  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    this.readCalls++;
    const buf = this.blobs.get(key);
    if (!buf) return null;
    const bytes = range ? buf.subarray(range.start, (range.end ?? buf.byteLength - 1) + 1) : buf;
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }
  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
  async signGetUrl(): Promise<string | null> {
    return null;
  }
  publicUrl(): string | null {
    return null;
  }
}

/**
 * Runtime harness mirroring `test/context.test.ts`'s `makeRuntime`: the `_storage` system table +
 * `storageModules` as `systemModules` (so `deps.runMutation`/`deps.runQuery` — which the real
 * server would satisfy via `EmbeddedRuntime.runSystem` — can reach `_storage:_finalize`/`_get`),
 * plus the `ctx.storage` context provider and a single `app:genUpload` mutation to mint a real
 * pending row (key === storageId, per `generateUploadUrl`'s determinism invariant) without
 * reimplementing that invariant by hand in every test.
 */
async function makeRuntime(blobStore: BlobStore): Promise<EmbeddedRuntime> {
  const schema = defineSchema({ [STORAGE_TABLE]: storageTableDefinition });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: {} }, [], {
    [STORAGE_TABLE]: STORAGE_TABLE_NUMBER,
  });
  const appModules: Record<string, RegisteredFunction> = {
    "app:genUpload": mutation(
      async (ctx: any, args: { contentType?: string; visibility?: "private" | "public" }) =>
        ctx.storage.generateUploadUrl(args),
    ),
    "app:del": mutation(async (ctx: any, { id }: { id: string }) => {
      await ctx.storage.delete(id);
      return null;
    }),
  };
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog,
    modules: appModules,
    systemModules: storageModules,
    componentNames: c.componentNames,
    contextProviders: [...c.contextProviders, storageContextProvider(blobStore, { signingKey: SIGNING_KEY })],
    policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry,
    bootSteps: c.bootSteps,
    drivers: c.drivers,
    tableNumbers: c.tableNumbers,
  });
}

function routeDeps(runtime: EmbeddedRuntime): StorageRouteDeps {
  return {
    signingKey: SIGNING_KEY,
    async runMutation(path, args) {
      return (await runtime.runSystem(path, args as never)).value;
    },
    async runQuery(path, args) {
      return (await runtime.runSystem(path, args as never)).value;
    },
  };
}

function findRoute(routes: StorageRoute[], method: string, path: string): StorageRoute {
  const route = routes.find((r) => r.method === method && path.startsWith(r.pathPrefix));
  if (!route) throw new Error(`no route matches ${method} ${path}`);
  return route;
}

async function mintPendingId(
  runtime: EmbeddedRuntime,
  contentType?: string,
  visibility?: "private" | "public",
): Promise<string> {
  const { value } = await runtime.run<{ storageId: string }>("app:genUpload", {
    ...(contentType !== undefined ? { contentType } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  });
  return value.storageId;
}

function tokenFor(scope: TokenScope, id: string, expiresInMs = 60_000): string {
  return createStorageToken(SIGNING_KEY, scope, id, Date.now() + expiresInMs);
}

async function getDoc(runtime: EmbeddedRuntime, id: string): Promise<Record<string, unknown> | null> {
  return (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value;
}

describe("POST /api/storage/upload", () => {
  it("valid token: stores the bytes, finalizes the row (ready), and returns {storageId}", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime, "text/plain");

    const body = new TextEncoder().encode("hello world");
    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor("upload", id)}`, {
      method: "POST",
      body,
      headers: { "content-type": "text/plain" },
    });

    const response = await findRoute(routes, "POST", "/api/storage/upload").handler(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ storageId: id });

    expect(blobStore.blobs.get(id)).toEqual(body);
    expect(await getDoc(runtime, id)).toMatchObject({ status: "ready", key: id, size: body.byteLength });
  });

  it("an invalid token is rejected (401) and no bytes are stored", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);

    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=not-a-real-token`, {
      method: "POST",
      body: new TextEncoder().encode("x"),
    });
    const response = await findRoute(routes, "POST", "/api/storage/upload").handler(request);

    expect(response.status).toBe(401);
    expect(blobStore.blobs.has(id)).toBe(false);
    expect(await getDoc(runtime, id)).toMatchObject({ status: "pending" });
  });

  it("an absent token is rejected (401)", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);

    const request = new Request(`http://localhost/api/storage/upload?id=${id}`, {
      method: "POST",
      body: new TextEncoder().encode("x"),
    });
    const response = await findRoute(routes, "POST", "/api/storage/upload").handler(request);
    expect(response.status).toBe(401);
    expect(blobStore.blobs.has(id)).toBe(false);
  });

  it("an expired token is rejected (401)", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);

    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor("upload", id, -1000)}`, {
      method: "POST",
      body: new TextEncoder().encode("x"),
    });
    const response = await findRoute(routes, "POST", "/api/storage/upload").handler(request);
    expect(response.status).toBe(401);
  });

  it("a GET-scoped token (minted for serving) is rejected against the upload endpoint (scope mismatch), and stored bytes are unchanged", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime, "text/plain");

    // Legitimately finalize the upload first, so there's a real `ready` blob whose bytes we can
    // prove stay untouched by the replay below.
    const original = new TextEncoder().encode("original bytes");
    const firstUpload = await findRoute(routes, "POST", "/api/storage/upload").handler(
      new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor("upload", id)}`, {
        method: "POST",
        body: new Uint8Array(original),
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(firstUpload.status).toBe(200);

    // A `"get"`-scoped token — exactly what `ctx.storage.getUrl()` embeds in a private file's url,
    // which is meant to be handed to a client/browser and can leak into logs/history/Referer — is
    // presented as the upload token. Before the scope-tagging fix this recomputed to the SAME HMAC
    // as an upload token for the same `(id, exp)` and would have authorized the write; now it must
    // be rejected outright.
    const getToken = tokenFor("get", id);
    const replay = await findRoute(routes, "POST", "/api/storage/upload").handler(
      new Request(`http://localhost/api/storage/upload?id=${id}&token=${getToken}`, {
        method: "POST",
        body: new TextEncoder().encode("attacker-injected bytes"),
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(replay.status).toBe(401);
    expect(blobStore.blobs.get(id)).toEqual(original);
    expect(await getDoc(runtime, id)).toMatchObject({ status: "ready", size: original.byteLength });
  });
});

describe("re-upload to an already-finalized row is refused (Layer 2 defense-in-depth)", () => {
  it("a still-valid upload token replayed against an already-`ready` row is rejected, and bytes/size/sha256 stay unchanged", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime, "text/plain");
    // Captured once and reused — the token itself doesn't expire for the full upload TTL window,
    // independent of the row's own lifecycle, so a client that held onto it can replay the call
    // well after the file has already been finalized.
    const token = tokenFor("upload", id);

    const original = new TextEncoder().encode("original bytes");
    const first = await findRoute(routes, "POST", "/api/storage/upload").handler(
      new Request(`http://localhost/api/storage/upload?id=${id}&token=${token}`, {
        method: "POST",
        body: new Uint8Array(original),
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(first.status).toBe(200);
    const readyDoc = await getDoc(runtime, id);
    expect(readyDoc).toMatchObject({ status: "ready", size: original.byteLength });
    const originalSha256 = (readyDoc as { sha256: string | null }).sha256;

    const replay = await findRoute(routes, "POST", "/api/storage/upload").handler(
      new Request(`http://localhost/api/storage/upload?id=${id}&token=${token}`, {
        method: "POST",
        body: new TextEncoder().encode("attacker-replayed bytes"),
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
    // The blob store's bytes and the row's recorded size/hash must be exactly what the FIRST,
    // legitimate upload produced — the replay must never have reached `blobStore.store`.
    expect(blobStore.blobs.get(id)).toEqual(original);
    expect(await getDoc(runtime, id)).toMatchObject({
      status: "ready",
      size: original.byteLength,
      sha256: originalSha256,
    });
  });
});

describe("POST /api/storage/confirm", () => {
  it("finalizes a pre-populated blob (direct upload landed out-of-band) and returns {storageId}", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);

    const bytes = new TextEncoder().encode("direct bytes");
    await blobStore.store(id, bytes); // simulate the client's direct-to-store upload

    const request = new Request(`http://localhost/api/storage/confirm?id=${id}&token=${tokenFor("upload", id)}`, {
      method: "POST",
    });
    const response = await findRoute(routes, "POST", "/api/storage/confirm").handler(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ storageId: id });
    expect(await getDoc(runtime, id)).toMatchObject({ status: "ready", size: bytes.byteLength });
  });

  it("a missing blob returns 409", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);

    const request = new Request(`http://localhost/api/storage/confirm?id=${id}&token=${tokenFor("upload", id)}`, {
      method: "POST",
    });
    const response = await findRoute(routes, "POST", "/api/storage/confirm").handler(request);

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("upload not found");
    expect(await getDoc(runtime, id)).toMatchObject({ status: "pending" });
  });

  it("an invalid token is rejected (401) even when the blob exists", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);
    await blobStore.store(id, new TextEncoder().encode("bytes"));

    const request = new Request(`http://localhost/api/storage/confirm?id=${id}&token=bogus`, { method: "POST" });
    const response = await findRoute(routes, "POST", "/api/storage/confirm").handler(request);
    expect(response.status).toBe(401);
    expect(await getDoc(runtime, id)).toMatchObject({ status: "pending" });
  });
});

describe("delete->re-confirm resurrection guard", () => {
  it("a still-valid upload token replayed AFTER ctx.storage.delete() is refused (404), not resurrected to ready", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime, "text/plain");
    const token = tokenFor("upload", id); // captured before the delete — mirrors a client holding a stale token

    // Finalize once (a legitimate upload lands).
    const firstBody = new TextEncoder().encode("original bytes");
    const firstUpload = await findRoute(routes, "POST", "/api/storage/upload").handler(
      new Request(`http://localhost/api/storage/upload?id=${id}&token=${token}`, {
        method: "POST",
        body: new Uint8Array(firstBody),
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(firstUpload.status).toBe(200);
    expect(await getDoc(runtime, id)).toMatchObject({ status: "ready" });

    // The row is deleted — tombstoned to an immediately-expired `pending` row (see
    // `../src/context.ts`'s `delete` doc comment), NOT hard-removed.
    await runtime.run("app:del", { id });
    const tombstoned = await getDoc(runtime, id);
    expect(tombstoned).toMatchObject({ status: "pending" });

    // The upload capability token is still cryptographically valid (its own `exp` hasn't passed) —
    // a client that captured it before the delete can replay the upload endpoint.
    const replayBody = new TextEncoder().encode("attacker-replayed bytes");
    const replay = await findRoute(routes, "POST", "/api/storage/upload").handler(
      new Request(`http://localhost/api/storage/upload?id=${id}&token=${token}`, {
        method: "POST",
        body: new Uint8Array(replayBody),
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(replay.status).toBe(404);
    // The row must NOT be resurrected to ready — it stays exactly as the tombstone left it.
    expect(await getDoc(runtime, id)).toMatchObject({ status: "pending" });
  });

  it("a still-valid confirm token replayed AFTER ctx.storage.delete() is refused (404), not resurrected to ready", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime, "text/plain");
    const token = tokenFor("upload", id);

    // Finalize once via confirm (simulating a direct-to-store upload landing out-of-band).
    const firstBytes = new TextEncoder().encode("original bytes");
    await blobStore.store(id, firstBytes);
    const firstConfirm = await findRoute(routes, "POST", "/api/storage/confirm").handler(
      new Request(`http://localhost/api/storage/confirm?id=${id}&token=${token}`, { method: "POST" }),
    );
    expect(firstConfirm.status).toBe(200);
    expect(await getDoc(runtime, id)).toMatchObject({ status: "ready" });

    // Delete tombstones the row.
    await runtime.run("app:del", { id });
    expect(await getDoc(runtime, id)).toMatchObject({ status: "pending" });

    // A second (attacker/leftover-client) blob write under the same key, then a replayed confirm
    // with the still-valid token — must not flip the tombstone back to ready.
    await blobStore.store(id, new TextEncoder().encode("attacker-replayed bytes"));
    const replayConfirm = await findRoute(routes, "POST", "/api/storage/confirm").handler(
      new Request(`http://localhost/api/storage/confirm?id=${id}&token=${token}`, { method: "POST" }),
    );

    expect(replayConfirm.status).toBe(404);
    expect(await getDoc(runtime, id)).toMatchObject({ status: "pending" });
  });
});

describe("GET /api/storage/:id — serve", () => {
  async function uploadReadyFile(
    runtime: EmbeddedRuntime,
    routes: StorageRoute[],
    bytes: Uint8Array,
    contentType?: string,
    visibility?: "private" | "public",
  ): Promise<string> {
    const id = await mintPendingId(runtime, contentType, visibility);
    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor("upload", id)}`, {
      method: "POST",
      // Re-wrapped (rather than passing `bytes` directly): a bare `Uint8Array`-typed parameter
      // widens to `Uint8Array<ArrayBufferLike>` under this repo's TS/@types-node combination,
      // which `BodyInit` rejects; a freshly-constructed `Uint8Array` narrows back to `<ArrayBuffer>`.
      body: new Uint8Array(bytes),
      ...(contentType !== undefined ? { headers: { "content-type": contentType } } : {}),
    });
    const response = await findRoute(routes, "POST", "/api/storage/upload").handler(request);
    expect(response.status).toBe(200);
    return id;
  }

  it("serves a ready file's exact bytes (200) with its content-type", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const bytes = new TextEncoder().encode("0123456789");
    const id = await uploadReadyFile(runtime, routes, bytes, "text/plain", "public");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("a Range request returns 206 with the correct partial bytes and Content-Range", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const bytes = new TextEncoder().encode("0123456789");
    const id = await uploadReadyFile(runtime, routes, bytes, undefined, "public");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`, { headers: { range: "bytes=2-5" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 2-5/${bytes.byteLength}`);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(2, 6));
  });

  it("an open-ended Range (bytes=5-) returns the rest of the file", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const bytes = new TextEncoder().encode("0123456789");
    const id = await uploadReadyFile(runtime, routes, bytes, undefined, "public");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`, { headers: { range: "bytes=5-" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 5-9/${bytes.byteLength}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(5));
  });

  it("a Range past EOF (bytes=0-999999 on a 10-byte file) clamps Content-Range to EOF and returns the full body", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const bytes = new TextEncoder().encode("0123456789"); // 10 bytes
    const id = await uploadReadyFile(runtime, routes, bytes, undefined, "public");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`, { headers: { range: "bytes=0-999999" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-9/${bytes.byteLength}`);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("a Range starting past EOF (bytes=20-30 on a 10-byte file) returns 416 with Content-Range: bytes */10", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const bytes = new TextEncoder().encode("0123456789"); // 10 bytes
    const id = await uploadReadyFile(runtime, routes, bytes, undefined, "public");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`, { headers: { range: "bytes=20-30" } }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${bytes.byteLength}`);
  });

  it("a full (non-range) 200 response sets Content-Length to the file's size", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const bytes = new TextEncoder().encode("0123456789");
    const id = await uploadReadyFile(runtime, routes, bytes, "text/plain", "public");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
  });

  it("a pending (not-yet-finalized) id returns 404", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );
    expect(response.status).toBe(404);
  });

  it("a missing id (well-formed but deleted) returns 404", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    // A syntactically-valid id that no longer resolves to a row (rather than an arbitrary string,
    // which `_storage:_get`'s `ctx.db.get` — like any table read — rejects at the id-codec layer
    // before it ever gets the chance to return `null`).
    const id = await mintPendingId(runtime);
    await runtime.runSystem("_storage:_delete", { id });

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );
    expect(response.status).toBe(404);
  });

  it("a malformed id (not decodable at all, e.g. attacker-supplied path junk) returns 404, not a 500", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));

    const response = await findRoute(routes, "GET", "/api/storage/does-not-exist").handler(
      new Request("http://localhost/api/storage/does-not-exist"),
    );
    expect(response.status).toBe(404);
  });

  it("a well-formed id whose backend query THROWS a generic (non-decode) error returns 500, not 404", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    // A syntactically-valid id (so the id-shape gate up front passes) whose `runQuery` then fails
    // for an unrelated reason (e.g. a DB outage) — must surface as a real 500, not be swallowed
    // into the same 404 a merely-nonexistent id gets.
    const id = await mintPendingId(runtime);
    const throwingDeps: StorageRouteDeps = {
      signingKey: SIGNING_KEY,
      async runMutation(path, args) {
        return (await runtime.runSystem(path, args as never)).value;
      },
      async runQuery() {
        throw new Error("boom: backend unavailable");
      },
    };
    const routes = storageRoutes(blobStore, throwingDeps);

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );
    expect(response.status).toBe(500);
  });

  it("a well-formed id whose backend query returns null (legitimately not found) still returns 404, not 500", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore);
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await mintPendingId(runtime);
    await runtime.runSystem("_storage:_delete", { id });

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/storage/:id — access control (Task 8)", () => {
  /** A `FakeBlobStore` whose `signGetUrl`/`publicUrl` are overridable per-test (default: both `null`,
   * same as the base fake — i.e. "no redirect backend, stream bytes"). */
  class RedirectableBlobStore extends FakeBlobStore {
    signedUrl: string | null = null;
    publicUrlValue: string | null = null;
    override async signGetUrl(): Promise<string | null> {
      return this.signedUrl;
    }
    override publicUrl(): string | null {
      return this.publicUrlValue;
    }
  }

  async function uploadReady(
    runtime: EmbeddedRuntime,
    routes: StorageRoute[],
    blobStore: FakeBlobStore,
    bytes: Uint8Array,
    visibility: "private" | "public",
  ): Promise<string> {
    const id = await mintPendingId(runtime, undefined, visibility);
    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor("upload", id)}`, {
      method: "POST",
      body: new Uint8Array(bytes),
    });
    const response = await findRoute(routes, "POST", "/api/storage/upload").handler(request);
    expect(response.status).toBe(200);
    return id;
  }

  function routeDepsWithCheckRead(
    runtime: EmbeddedRuntime,
    checkRead: (identity: string | null, id: string) => Promise<boolean>,
  ): StorageRouteDeps {
    return { ...routeDeps(runtime), checkRead };
  }

  it("private + checkRead() -> false: 403, and the blob's bytes are never read", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "private");
    blobStore.readCalls = 0; // reset after the upload's own internal writes/reads, if any

    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => false),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(403);
    expect(blobStore.readCalls).toBe(0);
  });

  it("private + checkRead() THROWS: 500 (not an unhandled rejection), and the blob's bytes are never read", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "private");
    blobStore.readCalls = 0;

    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => {
        throw new Error("authz backend exploded");
      }),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(500);
    expect(blobStore.readCalls).toBe(0);
  });

  it("private + checkRead() -> true, no redirect backend: 200 with bytes", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "private");

    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => true),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("private + checkRead() -> true, with a Range header: still 206 with correct partial bytes", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("0123456789");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "private");

    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => true),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`, { headers: { range: "bytes=2-5" } }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 2-5/${bytes.byteLength}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(2, 6));
  });

  it("private + checkRead() -> true, signGetUrl backend returns a url: 302 to the signed url (never streams)", async () => {
    const blobStore = new RedirectableBlobStore();
    blobStore.signedUrl = "https://cdn.example.com/signed?sig=abc";
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "private");
    blobStore.readCalls = 0;

    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => true),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(blobStore.signedUrl);
    expect(blobStore.readCalls).toBe(0);
  });

  it("private + checkRead never sees a redirect skip the check: checkRead(false) still 403s even when signGetUrl has a url", async () => {
    const blobStore = new RedirectableBlobStore();
    blobStore.signedUrl = "https://cdn.example.com/signed?sig=abc";
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "private");

    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => false),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(403);
  });

  it("public file + publicUrl backend returns a url: 302 to it, WITHOUT consulting checkRead", async () => {
    const blobStore = new RedirectableBlobStore();
    blobStore.publicUrlValue = "https://cdn.example.com/public/blob";
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("public bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "public");

    let checkReadCalls = 0;
    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => {
        checkReadCalls++;
        return false; // would 403 if it were (wrongly) consulted for a public file
      }),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(blobStore.publicUrlValue);
    expect(checkReadCalls).toBe(0);
  });

  it("public file + publicUrl backend returns null: 200 streamed, no checkRead consulted", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("public bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "public");

    let checkReadCalls = 0;
    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async () => {
        checkReadCalls++;
        return false;
      }),
    );
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(checkReadCalls).toBe(0);
  });

  it("private + no checkRead dep (authz not composed) + a valid capability token: served (200, no redirect backend)", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, routes, blobStore, bytes, "private");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}?token=${tokenFor("get", id)}`),
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("private + no checkRead dep + a valid token + signGetUrl backend returns a url: 302", async () => {
    const blobStore = new RedirectableBlobStore();
    blobStore.signedUrl = "https://cdn.example.com/signed?sig=xyz";
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, routes, blobStore, bytes, "private");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}?token=${tokenFor("get", id)}`),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(blobStore.signedUrl);
  });

  it("private + no checkRead dep + an ABSENT token: 403 (fails closed, not open)", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, routes, blobStore, bytes, "private");
    blobStore.readCalls = 0;

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`),
    );

    expect(response.status).toBe(403);
    expect(blobStore.readCalls).toBe(0);
  });

  it("private + no checkRead dep + an INVALID token: 403", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, routes, blobStore, bytes, "private");

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}?token=not-a-real-token`),
    );

    expect(response.status).toBe(403);
  });

  it("an upload-scoped token used as the GET-capability token is rejected (403, scope mismatch), and bytes are never read", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const routes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, routes, blobStore, bytes, "private");
    blobStore.readCalls = 0;

    // A fresh `"upload"`-scoped token for this same id — before the scope-tagging fix this
    // recomputed to the SAME HMAC as a `"get"` token for the same `(id, exp)` and would have been
    // accepted by the serve endpoint's no-authz fallback; now it must be rejected.
    const uploadToken = tokenFor("upload", id);
    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}?token=${uploadToken}`),
    );

    expect(response.status).toBe(403);
    expect(blobStore.readCalls).toBe(0);
  });

  it("checkRead receives the raw Bearer token as identity, and null when the header is absent", async () => {
    const blobStore = new RedirectableBlobStore();
    const runtime = await makeRuntime(blobStore);
    const bytes = new TextEncoder().encode("secret bytes");
    const uploadRoutes = storageRoutes(blobStore, routeDeps(runtime));
    const id = await uploadReady(runtime, uploadRoutes, blobStore, bytes, "private");

    const seen: Array<string | null> = [];
    const routes = storageRoutes(
      blobStore,
      routeDepsWithCheckRead(runtime, async (identity) => {
        seen.push(identity);
        return true;
      }),
    );

    await findRoute(routes, "GET", `/api/storage/${id}`).handler(new Request(`http://localhost/api/storage/${id}`));
    await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`, { headers: { authorization: "Bearer user-abc-token" } }),
    );

    expect(seen).toEqual([null, "user-abc-token"]);
  });
});
