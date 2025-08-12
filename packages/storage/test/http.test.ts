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
import { createStorageToken } from "../src/token";
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
    "app:genUpload": mutation(async (ctx: any, args: { contentType?: string }) => ctx.storage.generateUploadUrl(args)),
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

async function mintPendingId(runtime: EmbeddedRuntime, contentType?: string): Promise<string> {
  const { value } = await runtime.run<{ storageId: string }>("app:genUpload", {
    ...(contentType !== undefined ? { contentType } : {}),
  });
  return value.storageId;
}

function tokenFor(id: string, expiresInMs = 60_000): string {
  return createStorageToken(SIGNING_KEY, id, Date.now() + expiresInMs);
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
    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor(id)}`, {
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

    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor(id, -1000)}`, {
      method: "POST",
      body: new TextEncoder().encode("x"),
    });
    const response = await findRoute(routes, "POST", "/api/storage/upload").handler(request);
    expect(response.status).toBe(401);
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

    const request = new Request(`http://localhost/api/storage/confirm?id=${id}&token=${tokenFor(id)}`, {
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

    const request = new Request(`http://localhost/api/storage/confirm?id=${id}&token=${tokenFor(id)}`, {
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

describe("GET /api/storage/:id — serve", () => {
  async function uploadReadyFile(
    runtime: EmbeddedRuntime,
    routes: StorageRoute[],
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<string> {
    const id = await mintPendingId(runtime, contentType);
    const request = new Request(`http://localhost/api/storage/upload?id=${id}&token=${tokenFor(id)}`, {
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
    const id = await uploadReadyFile(runtime, routes, bytes, "text/plain");

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
    const id = await uploadReadyFile(runtime, routes, bytes);

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
    const id = await uploadReadyFile(runtime, routes, bytes);

    const response = await findRoute(routes, "GET", `/api/storage/${id}`).handler(
      new Request(`http://localhost/api/storage/${id}`, { headers: { range: "bytes=5-" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 5-9/${bytes.byteLength}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(5));
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
});
