import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { decodeDocumentId } from "@stackbase/id-codec";
import { query, mutation, action, type RegisteredFunction } from "@stackbase/executor";
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
import { storageContextProvider, signUploadToken, storageEndpointPath } from "../src/context";
import { verifyStorageToken } from "../src/token";

/**
 * A minimal in-file `BlobStore` fake (the real `MemoryBlobStore` in `@stackbase/blobstore`'s
 * test-support isn't a published export). `store` hashes the bytes so the metadata round-trip is
 * exercised; `createUploadTarget` returns a `proxied` target the way the real memory store does.
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

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

class FakeBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async createUploadTarget(key: string, _opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    return { kind: "proxied", url: `/api/storage/upload?key=${encodeURIComponent(key)}`, method: "POST" };
  }
  async store(key: string, bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<StoredBlob> {
    const buf = await toBytes(bytes);
    this.blobs.set(key, buf);
    return { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
  }
  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    const buf = this.blobs.get(key);
    return buf ? { size: buf.byteLength, sha256: null } : null;
  }
  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const buf = this.blobs.get(key);
    if (!buf) return null;
    if (!range) return streamOf(buf);
    const end = range.end ?? buf.byteLength - 1;
    return streamOf(buf.subarray(range.start, end + 1));
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
 * Harness mirroring `test/modules.test.ts`, plus the `ctx.storage` context provider and a set of
 * app functions that exercise it. `storageModules` are registered BOTH as `systemModules` (so the
 * test can assert `_storage` rows directly via `runSystem`) and in `modules` (so the action-mode
 * facade's `api.runMutation("_storage:_insertReady")` / `api.runQuery("_storage:_get")` — routed
 * through the runtime's trusted `invoke`, which only resolves `modules` — reach them). Their
 * `_`-prefixed keys keep them off the public `run`/`runAction` surface.
 */
async function makeRuntime(
  blobStore: BlobStore,
  appModules: Record<string, RegisteredFunction>,
  now?: () => number,
): Promise<EmbeddedRuntime> {
  const schema = defineSchema({ [STORAGE_TABLE]: storageTableDefinition });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: {} }, [], {
    [STORAGE_TABLE]: STORAGE_TABLE_NUMBER,
  });
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog,
    modules: { ...appModules, ...storageModules },
    systemModules: storageModules,
    componentNames: c.componentNames,
    contextProviders: [...c.contextProviders, storageContextProvider(blobStore, { signingKey: "test-signing-key" })],
    policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry,
    bootSteps: c.bootSteps,
    drivers: c.drivers,
    tableNumbers: c.tableNumbers,
    now,
  });
}

const UPLOAD_TTL_MS = 3_600_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appModules: Record<string, RegisteredFunction> = {
  "app:genUpload": mutation(async (ctx: any, args: { contentType?: string; visibility?: "private" | "public" }) =>
    ctx.storage.generateUploadUrl(args),
  ),
  "app:getUrl": query(async (ctx: any, { id }: { id: string }) => ctx.storage.getUrl(id)),
  "app:getMetadata": query(async (ctx: any, { id }: { id: string }) => ctx.storage.getMetadata(id)),
  "app:del": mutation(async (ctx: any, { id }: { id: string }) => {
    await ctx.storage.delete(id);
    return null;
  }),
  // Action bodies build their own bytes (avoids threading a Uint8Array through the arg codec).
  "app:store": action(async (ctx: any, { text, contentType }: { text: string; contentType?: string }) =>
    ctx.storage.store(new TextEncoder().encode(text), contentType !== undefined ? { contentType } : undefined),
  ),
  "app:getBytes": action(async (ctx: any, { id }: { id: string }) => {
    const stream = await ctx.storage.get(id);
    if (stream === null) return null;
    return new TextDecoder().decode(await toBytes(stream as ReadableStream<Uint8Array>));
  }),
  "app:getMetaAction": action(async (ctx: any, { id }: { id: string }) => ctx.storage.getMetadata(id)),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("ctx.storage — mutation/query facade (build)", () => {
  it("generateUploadUrl inserts a pending row (key === id, expiresAt = now + ttl) and returns a proxied target with a capability token", async () => {
    const NOW = 1_700_000_000_000;
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore, appModules, () => NOW);

    const { value } = await runtime.run<{ storageId: string; target: UploadTarget }>("app:genUpload", {
      contentType: "text/plain",
    });
    expect(typeof value.storageId).toBe("string");
    expect(decodeDocumentId(value.storageId).tableNumber).toBe(STORAGE_TABLE_NUMBER);
    expect(value.target.kind).toBe("proxied");
    // The proxied URL carries the capability token + its expiry over the row id.
    const exp = NOW + UPLOAD_TTL_MS;
    const expectedToken = signUploadToken("test-signing-key", { id: value.storageId, exp });
    expect(value.target.url).toContain(`exp=${exp}`);
    expect(value.target.url).toContain(`token=${expectedToken}`);

    // A pending _storage row exists with key === id and the future expiry.
    const doc = (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id: value.storageId }))
      .value;
    expect(doc).toMatchObject({
      status: "pending",
      key: value.storageId,
      contentType: "text/plain",
      visibility: "private",
      size: null,
      sha256: null,
      expiresAt: exp,
    });
  });

  it("getUrl returns the /api/storage/<id> endpoint with a verifiable, deterministic capability token for a private file, and null for a missing id", async () => {
    const NOW = 1_700_000_000_000;
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore, appModules, () => NOW);

    const { value } = await runtime.run<{ storageId: string }>("app:genUpload", {});
    const url = (await runtime.run<string | null>("app:getUrl", { id: value.storageId })).value;

    // Endpoint + a `?token=` capability token, so the serve endpoint's no-authz fallback accepts it.
    expect(url).not.toBeNull();
    expect(url!.startsWith(`${storageEndpointPath(value.storageId)}?token=`)).toBe(true);
    const token = new URL(url!, "http://x").searchParams.get("token")!;
    // The token verifies against the same signing key the routes use, at the deterministic `now`.
    expect(verifyStorageToken("test-signing-key", value.storageId, token, NOW)).toBe(true);

    // Deterministic: the expiry is derived from `cctx.now` (fixed here), so a re-run — an OCC replay
    // — yields the byte-identical url (a wall-clock `Date.now()` would drift and break query safety).
    const url2 = (await runtime.run<string | null>("app:getUrl", { id: value.storageId })).value;
    expect(url2).toBe(url);

    // A decodable-but-absent id (delete the row first) reads null, not an error.
    await runtime.run("app:del", { id: value.storageId });
    const missing = (await runtime.run<string | null>("app:getUrl", { id: value.storageId })).value;
    expect(missing).toBeNull();
  });

  it("delete tombstones the row transactionally (blob left for the reaper)", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore, appModules);

    const { value } = await runtime.run<{ storageId: string }>("app:genUpload", {});
    expect((await runtime.runSystem("_storage:_get", { id: value.storageId })).value).not.toBeNull();

    await runtime.run("app:del", { id: value.storageId });
    expect((await runtime.runSystem("_storage:_get", { id: value.storageId })).value).toBeNull();
  });

  it("signUploadToken is a pure/deterministic function of (key, id, exp)", () => {
    const a = signUploadToken("k", { id: "abc", exp: 100 });
    const b = signUploadToken("k", { id: "abc", exp: 100 });
    expect(a).toBe(b); // same inputs → same token (safe to compute in a mutation / on replay)
    expect(signUploadToken("k", { id: "abc", exp: 101 })).not.toBe(a); // exp changes it
    expect(signUploadToken("k", { id: "abd", exp: 100 })).not.toBe(a); // id changes it
    expect(signUploadToken("k2", { id: "abc", exp: 100 })).not.toBe(a); // key changes it
  });
});

describe("ctx.storage — action facade (buildAction)", () => {
  it("store writes bytes to the blob store, inserts a ready row, and get streams the bytes back", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore, appModules);

    const text = "hello world";
    const id = (await runtime.runAction<string>("app:store", { text, contentType: "text/plain" })).value;
    expect(typeof id).toBe("string");
    expect(decodeDocumentId(id).tableNumber).toBe(STORAGE_TABLE_NUMBER);

    // A ready row was inserted with the right metadata.
    const expectedSha = createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
    const doc = (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value;
    expect(doc).toMatchObject({
      status: "ready",
      size: text.length,
      sha256: expectedSha,
      contentType: "text/plain",
      visibility: "private",
    });

    // The bytes actually landed in the blob store under the row's key.
    const key = (doc as Record<string, unknown>).key as string;
    expect(blobStore.blobs.has(key)).toBe(true);

    // get() streams the exact bytes back.
    const roundTripped = (await runtime.runAction<string | null>("app:getBytes", { id })).value;
    expect(roundTripped).toBe(text);

    // getMetadata() from the action facade returns the same size/sha256.
    const meta = (await runtime.runAction<{ size: number; sha256: string } | null>("app:getMetaAction", { id })).value;
    expect(meta).toMatchObject({ size: text.length, sha256: expectedSha });
  });

  it("get returns null for a missing id", async () => {
    const blobStore = new FakeBlobStore();
    const runtime = await makeRuntime(blobStore, appModules);
    const id = (await runtime.runAction<string>("app:store", { text: "x" })).value;
    await runtime.runSystem("_storage:_delete", { id });
    expect((await runtime.runAction<string | null>("app:getBytes", { id })).value).toBeNull();
  });
});
