# File Storage (Slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Stackbase apps Convex-parity file storage — `Id<"_storage">` typed references, `ctx.storage` byte I/O, and two-phase uploads — over a pluggable `BlobStore` seam that spans a zero-config local-disk default and a presigned-direct-to-bucket S3/R2 adapter, with no application-code change between them.

**Architecture:** A thin `BlobStore` seam (`packages/blobstore`) with two adapters behind it (`blobstore-fs` default, `blobstore-s3` scale path), plus a core-wired feature package (`packages/storage`) that owns the `_storage` app-namespace system table, the `ctx.storage` context provider, the reserved `/api/storage/*` HTTP endpoints, and an orphan-reaper driver. Byte I/O rides actions' native capabilities (bytes aren't JSON-serializable); metadata ops ride the `ctx.db` syscall channel and stay reactive. The feature reuses the same `ContextProvider`/`Driver`/system-table/route seams the opt-in components use, but boot installs it unconditionally.

**Tech Stack:** TypeScript, Bun (runtime + package manager), Turborepo, vitest (under Node), tsup (build). `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` for the S3 adapter. MinIO (`minio/minio` container) for the S3 ship-gate E2E.

## Global Constraints

- **The engine never learns which byte backend it's on.** No `fs`/S3/AWS-SDK specifics may leak outside `packages/blobstore-fs` / `packages/blobstore-s3`. Everything else imports only `packages/blobstore`'s interface. (Same rule as the `DocStore` seam.)
- **The S3 SDK is a dependency of `packages/blobstore-s3` ONLY** — never of `packages/blobstore`, `packages/storage`, or any engine package. An FS-only deploy / single binary must not bundle it.
- **SQLite/FS stay the zero-config default.** File storage works out of the box on local disk with no config; S3 is opt-in via config/env.
- **Byte I/O (`ctx.storage.store`/`get`) is action-only**; `getUrl`/`getMetadata` work in queries; `generateUploadUrl`/`delete` work in mutations. This tiering is load-bearing for determinism — never expose byte I/O to a query/mutation.
- **`generateUploadUrl` stays deterministic** by signing against the transaction clock (`cctx.now`), not wall-clock. `BlobStore.createUploadTarget`/`signGetUrl` take `now` explicitly. If a backend's presign cannot accept an injected clock, that backend's `generateUploadUrl` degrades to action tier; FS/proxied stays a mutation.
- **`sha256` is best-effort:** computed on the proxied path (bytes stream through the server), `null` on the presigned-direct path (bytes never transit the server). No dedup in v1.
- **Files are private by default.** `getUrl` returns our serve endpoint for private files; `visibility: "public"` opts into a stable CDN url.
- **Tests run under Node/vitest** (`globalThis.Bun` is undefined in the suite). Do not write Bun-API-only assertions in unit tests. The real-Bun path is covered only by the E2E ship gate.
- **Every cross-package feature needs an E2E through the real `stackbase serve` server**, not just mechanism unit tests. The MinIO container E2E is the ship gate (mirrors the `postgres:16` proof).
- Node ≥ 22 supported target; Bun ≥ 1.2 dev runtime.

---

## File Structure

```
packages/blobstore/                    # the seam — NEW
  package.json, tsconfig.json, tsup.config.ts
  src/index.ts                         # re-exports
  src/types.ts                         # BlobStore, UploadTarget, StoredBlob, BlobMetadata
  test-support/conformance.ts          # runBlobStoreConformance(label, makeStore, teardown?)
  test-support/memory-blobstore.ts     # MemoryBlobStore (in-proc reference impl for the suite)
  test/memory.test.ts                  # conformance vs MemoryBlobStore

packages/blobstore-fs/                 # local-disk adapter (default) — NEW
  package.json, tsconfig.json, tsup.config.ts
  src/index.ts, src/fs-blobstore.ts
  test/fs.test.ts                      # conformance vs a temp dir + Range/sha256

packages/blobstore-s3/                 # S3/R2 adapter (scale path) — NEW
  package.json, tsconfig.json, tsup.config.ts
  src/index.ts, src/s3-blobstore.ts, src/s3-config.ts
  test/s3.test.ts                      # env-gated conformance vs MinIO (STACKBASE_TEST_S3_*)

packages/storage/                      # the core feature — NEW
  package.json, tsconfig.json, tsup.config.ts
  src/index.ts
  src/system-table.ts                  # the _storage TableDefinition + STORAGE_TABLE_NUMBER
  src/modules.ts                       # internal mutations: _createPending/_insertReady/_finalize/_delete/_reapExpired
  src/context.ts                       # storageContext (build) + storageActionContext (buildAction)
  src/http.ts                          # upload/confirm/serve reserved-route handlers
  src/reaper.ts                        # storageReaper() Driver
  test/*.test.ts                       # per-file unit tests

packages/codegen/src/generate.ts       # MODIFY — inject _storage into DataModel + validators
packages/id-codec/src/table-registry.ts# (verify) _storage system-table-number reservation
packages/cli/src/boot.ts               # MODIFY — makeBlobStore + always-wire storage feature
packages/cli/test/storage-e2e.test.ts  # NEW — FS hermetic + MinIO container ship gate
docs/enduser/...                       # NEW — file storage guide + ctx.storage reference
```

---

## Task 1: The `BlobStore` seam + conformance suite

**Files:**
- Create: `packages/blobstore/package.json`, `packages/blobstore/tsconfig.json`, `packages/blobstore/tsup.config.ts`
- Create: `packages/blobstore/src/types.ts`, `packages/blobstore/src/index.ts`
- Create: `packages/blobstore/test-support/memory-blobstore.ts`, `packages/blobstore/test-support/conformance.ts`
- Test: `packages/blobstore/test/memory.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  ```ts
  export type UploadTarget =
    | { kind: "proxied"; url: string; method: "POST"; headers?: Record<string, string> }
    | { kind: "presigned"; url: string; method: "PUT"; headers?: Record<string, string> };
  export interface StoredBlob { size: number; sha256: string | null }
  export interface BlobMetadata { size: number | null; contentType: string | null; sha256: string | null }
  export interface CreateUploadTargetOpts { contentType?: string; expiresInMs: number; now: number }
  export interface SignUrlOpts { expiresInMs: number; now: number }
  export interface ByteRange { start: number; end?: number }
  export interface BlobStore {
    createUploadTarget(key: string, opts: CreateUploadTargetOpts): Promise<UploadTarget>;
    store(key: string, bytes: ReadableStream<Uint8Array> | Uint8Array, opts?: { contentType?: string }): Promise<StoredBlob>;
    finalizeUpload(key: string): Promise<StoredBlob | null>;
    read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
    delete(key: string): Promise<void>;
    signGetUrl(key: string, opts: SignUrlOpts): Promise<string | null>; // async: the S3 presigner returns a Promise
    publicUrl(key: string): string | null;
  }
  export function runBlobStoreConformance(label: string, makeStore: () => BlobStore | Promise<BlobStore>, teardown?: () => Promise<void> | void): void;
  export class MemoryBlobStore implements BlobStore { /* in-proc */ }
  ```

- [ ] **Step 1: Scaffold the package.** Create `packages/blobstore/package.json` (mirror `packages/docstore-sqlite/package.json` but no `test:bun`, no `id-codec`/`values` deps — the seam is dependency-free):

```json
{
  "name": "@stackbase/blobstore",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "sideEffects": false,
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./test-support": { "types": "./dist/test-support/conformance.d.ts", "default": "./dist/test-support/conformance.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "tsup": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

Copy `packages/docstore-sqlite/tsconfig.json` verbatim to `packages/blobstore/tsconfig.json`. Create `packages/blobstore/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "test-support/conformance.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
```

- [ ] **Step 2: Write `src/types.ts`** — exactly the `Interfaces` block above (the `interface`/`type`/`class`-less declarations: `UploadTarget`, `StoredBlob`, `BlobMetadata`, `CreateUploadTargetOpts`, `SignUrlOpts`, `ByteRange`, `BlobStore`). No implementations here.

- [ ] **Step 3: Write `src/index.ts`:**

```ts
export * from "./types";
```

- [ ] **Step 4: Write `test-support/memory-blobstore.ts`** — an in-process reference used only to exercise the suite. It stores bytes in a `Map`, computes sha256 with `node:crypto`, supports Range, and returns `proxied` upload targets (it has no real bucket, so `signGetUrl`/`publicUrl` return `null`):

```ts
import { createHash } from "node:crypto";
import type { BlobStore, UploadTarget, StoredBlob, ByteRange, CreateUploadTargetOpts, SignUrlOpts } from "../src/types";

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
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

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
    if (!buf) return null;
    return { size: buf.byteLength, sha256: null }; // direct-path: sha256 unknown
  }
  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const buf = this.blobs.get(key);
    if (!buf) return null;
    if (!range) return streamOf(buf);
    const end = range.end ?? buf.byteLength - 1;
    return streamOf(buf.subarray(range.start, end + 1));
  }
  async delete(key: string): Promise<void> { this.blobs.delete(key); }
  async signGetUrl(_key: string, _opts: SignUrlOpts): Promise<string | null> { return null; }
  publicUrl(_key: string): string | null { return null; }
}
```

- [ ] **Step 5: Write `test-support/conformance.ts`** — the shared behavioral suite (the parity contract every adapter runs). Wrap in a labeled `describe` so it can be called more than once without hook-scope leaks (the lesson from the DocStore conformance suite):

```ts
import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import type { BlobStore } from "../src/types";

async function drain(s: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!s) throw new Error("expected a stream, got null");
  const chunks: Uint8Array[] = [];
  const reader = s.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export function runBlobStoreConformance(
  label: string,
  makeStore: () => BlobStore | Promise<BlobStore>,
  teardown?: () => Promise<void> | void,
): void {
  describe(`BlobStore conformance: ${label}`, () => {
    afterAll(async () => { await teardown?.(); });

    it("stores and reads back bytes", async () => {
      const store = await makeStore();
      const data = new TextEncoder().encode("hello stackbase");
      const res = await store.store("k1", data);
      expect(res.size).toBe(data.byteLength);
      const round = await drain(await store.read("k1"));
      expect(new TextDecoder().decode(round)).toBe("hello stackbase");
    });

    it("computes sha256 on store()", async () => {
      const store = await makeStore();
      const data = new TextEncoder().encode("checksum me");
      const res = await store.store("k2", data);
      expect(res.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    });

    it("returns null reading a missing key", async () => {
      const store = await makeStore();
      expect(await store.read("nope")).toBeNull();
    });

    it("serves a byte range", async () => {
      const store = await makeStore();
      await store.store("k3", new TextEncoder().encode("0123456789"));
      const part = await drain(await store.read("k3", { start: 2, end: 5 }));
      expect(new TextDecoder().decode(part)).toBe("2345");
    });

    it("deletes a blob", async () => {
      const store = await makeStore();
      await store.store("k4", new TextEncoder().encode("x"));
      await store.delete("k4");
      expect(await store.read("k4")).toBeNull();
    });

    it("finalizeUpload returns null for a never-uploaded key", async () => {
      const store = await makeStore();
      expect(await store.finalizeUpload("ghost")).toBeNull();
    });

    it("createUploadTarget returns a usable target", async () => {
      const store = await makeStore();
      const t = await store.createUploadTarget("k5", { expiresInMs: 60_000, now: 1_700_000_000_000 });
      expect(t.kind === "proxied" || t.kind === "presigned").toBe(true);
      expect(typeof t.url).toBe("string");
    });
  });
}
```

- [ ] **Step 6: Write `test/memory.test.ts`:**

```ts
import { runBlobStoreConformance } from "../test-support/conformance";
import { MemoryBlobStore } from "../test-support/memory-blobstore";
runBlobStoreConformance("memory", () => new MemoryBlobStore());
```

- [ ] **Step 7: Run tests — verify pass.** Run: `bun run --filter @stackbase/blobstore test`
Expected: PASS (7 conformance tests green). Then `bun run --filter @stackbase/blobstore typecheck` → no errors.

- [ ] **Step 8: Commit.**

```bash
git add packages/blobstore
git commit -m "feat(blobstore): BlobStore seam + shared conformance suite"
```

---

## Task 2: `packages/blobstore-fs` — local-disk adapter (the default)

**Files:**
- Create: `packages/blobstore-fs/package.json`, `tsconfig.json`, `tsup.config.ts`
- Create: `packages/blobstore-fs/src/index.ts`, `packages/blobstore-fs/src/fs-blobstore.ts`
- Test: `packages/blobstore-fs/test/fs.test.ts`

**Interfaces:**
- Consumes: `BlobStore`, `UploadTarget`, `StoredBlob`, `ByteRange`, `CreateUploadTargetOpts`, `SignUrlOpts` from `@stackbase/blobstore`.
- Produces:
  ```ts
  export class FsBlobStore implements BlobStore {
    constructor(opts: { root: string });
  }
  ```
  FS is proxied-only: `createUploadTarget` → `{ kind: "proxied", url: "/api/storage/upload", method: "POST" }` (the token is added by the caller, not the adapter); `signGetUrl` → `null`; `publicUrl` → `null` (FS files are served through our endpoint, never a bucket).

- [ ] **Step 1: Scaffold.** `package.json` mirrors Task 1's but name `@stackbase/blobstore-fs`, and adds `"dependencies": { "@stackbase/blobstore": "workspace:*" }`. `tsup.config.ts` has `entry: ["src/index.ts"]`. Copy the tsconfig.

- [ ] **Step 2: Write the failing test `test/fs.test.ts`:**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runBlobStoreConformance } from "@stackbase/blobstore/test-support";
import { FsBlobStore } from "../src/fs-blobstore";

const dir = mkdtempSync(join(tmpdir(), "sb-fs-blob-"));
runBlobStoreConformance("fs", () => new FsBlobStore({ root: dir }), () => rmSync(dir, { recursive: true, force: true }));

describe("FsBlobStore specifics", () => {
  it("createUploadTarget is always proxied; signGetUrl/publicUrl are null", async () => {
    const store = new FsBlobStore({ root: mkdtempSync(join(tmpdir(), "sb-fs-blob2-")) });
    const t = await store.createUploadTarget("k", { expiresInMs: 1000, now: 1 });
    expect(t.kind).toBe("proxied");
    expect(store.signGetUrl("k", { expiresInMs: 1000, now: 1 })).toBeNull();
    expect(store.publicUrl("k")).toBeNull();
  });
});
```

- [ ] **Step 3: Run — verify it fails.** Run: `bun run --filter @stackbase/blobstore-fs test`
Expected: FAIL — `Cannot find module '../src/fs-blobstore'`.

- [ ] **Step 4: Implement `src/fs-blobstore.ts`.** Keys may contain `/`; map a key to `<root>/<key>` and `mkdir -p` the parent on write. Stream bytes to disk computing sha256 as they pass; read returns a `node:fs` read stream (with `start`/`end` for Range) adapted to a web `ReadableStream`.

```ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type {
  BlobStore, UploadTarget, StoredBlob, ByteRange, CreateUploadTargetOpts, SignUrlOpts,
} from "@stackbase/blobstore";

export class FsBlobStore implements BlobStore {
  private readonly root: string;
  constructor(opts: { root: string }) { this.root = opts.root; }

  private path(key: string): string { return join(this.root, key); }

  async createUploadTarget(_key: string, _opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    return { kind: "proxied", url: "/api/storage/upload", method: "POST" };
  }

  async store(key: string, bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<StoredBlob> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const out = createWriteStream(p);
    const source = bytes instanceof Uint8Array ? Readable.from([bytes]) : Readable.fromWeb(bytes as any);
    await new Promise<void>((resolve, reject) => {
      source.on("data", (chunk: Buffer) => { hash.update(chunk); size += chunk.byteLength; });
      source.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      source.pipe(out);
    });
    return { size, sha256: hash.digest("hex") };
  }

  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    try { const s = await stat(this.path(key)); return { size: s.size, sha256: null }; }
    catch { return null; }
  }

  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    try { await stat(this.path(key)); } catch { return null; }
    const node = createReadStream(this.path(key), range ? { start: range.start, end: range.end } : {});
    return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> { await rm(this.path(key), { force: true }); }
  async signGetUrl(_key: string, _opts: SignUrlOpts): Promise<string | null> { return null; }
  publicUrl(_key: string): string | null { return null; }
}
```

Write `src/index.ts`: `export { FsBlobStore } from "./fs-blobstore";`

- [ ] **Step 5: Run — verify pass.** Run: `bun run --filter @stackbase/blobstore-fs test`
Expected: PASS (7 conformance + 1 specifics). Then `typecheck` clean.

- [ ] **Step 6: Commit.**

```bash
git add packages/blobstore-fs
git commit -m "feat(blobstore-fs): local-disk adapter — the zero-config default"
```

---

## Task 3: `packages/blobstore-s3` — S3/R2 adapter (the scale path)

**Files:**
- Create: `packages/blobstore-s3/package.json`, `tsconfig.json`, `tsup.config.ts`
- Create: `packages/blobstore-s3/src/index.ts`, `src/s3-config.ts`, `src/s3-blobstore.ts`
- Test: `packages/blobstore-s3/test/s3.test.ts`

**Interfaces:**
- Consumes: `BlobStore` etc. from `@stackbase/blobstore`.
- Produces:
  ```ts
  export interface S3Config {
    bucket: string; region?: string; endpoint?: string;
    accessKeyId?: string; secretAccessKey?: string;
    forcePathStyle?: boolean;      // true for MinIO/R2-style endpoints
    publicBaseUrl?: string;        // CDN/public base; enables publicUrl()
  }
  export class S3BlobStore implements BlobStore { constructor(config: S3Config); }
  ```
  S3 is presigned-first: `createUploadTarget` → `{ kind: "presigned", url: <presigned PUT>, method: "PUT", headers }`; `signGetUrl` → a presigned GET url; `publicUrl` → `${publicBaseUrl}/${key}` or `null`; `finalizeUpload` → `HeadObject` (size from `ContentLength`, `sha256: null`); `store`/`read`/`delete` → `PutObject`/`GetObject`(+`Range`)/`DeleteObject`.

- [ ] **Step 1: Scaffold + deps.** `package.json` name `@stackbase/blobstore-s3`, dependencies:

```json
"dependencies": {
  "@stackbase/blobstore": "workspace:*",
  "@aws-sdk/client-s3": "catalog:",
  "@aws-sdk/s3-request-presigner": "catalog:"
}
```

Add both AWS packages to the root `catalog:` in the workspace catalog (pin a current 3.x). Run `bun install`.

- [ ] **Step 2: Write `src/s3-config.ts`** — builds the SDK client from `S3Config`:

```ts
import { S3Client } from "@aws-sdk/client-s3";
import type { S3Config } from "./s3-blobstore";

export function makeS3Client(c: S3Config): S3Client {
  return new S3Client({
    region: c.region ?? "us-east-1",
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle ?? Boolean(c.endpoint),
    credentials: c.accessKeyId && c.secretAccessKey
      ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
      : undefined,
  });
}
```

- [ ] **Step 3: Write the env-gated test `test/s3.test.ts`** (runs the shared conformance suite against a real S3/MinIO endpoint only when `STACKBASE_TEST_S3_ENDPOINT` is set — same env-gate pattern as the Postgres real-DB conformance run; the container run itself is Task 11):

```ts
import { runBlobStoreConformance } from "@stackbase/blobstore/test-support";
import { S3BlobStore } from "../src/s3-blobstore";

const endpoint = process.env.STACKBASE_TEST_S3_ENDPOINT;
const bucket = process.env.STACKBASE_TEST_S3_BUCKET ?? "stackbase-test";

if (endpoint) {
  runBlobStoreConformance("s3-minio", () => new S3BlobStore({
    bucket, endpoint, forcePathStyle: true, region: "us-east-1",
    accessKeyId: process.env.STACKBASE_TEST_S3_KEY ?? "minioadmin",
    secretAccessKey: process.env.STACKBASE_TEST_S3_SECRET ?? "minioadmin",
  }));
} else {
  // eslint-disable-next-line no-console
  import("vitest").then(({ it }) => it.skip("s3 conformance (set STACKBASE_TEST_S3_ENDPOINT)", () => {}));
}
```

- [ ] **Step 4: Run — verify it fails to import.** Run: `bun run --filter @stackbase/blobstore-s3 test`
Expected: FAIL — `Cannot find module '../src/s3-blobstore'` (the skip branch still imports it at top).

- [ ] **Step 5: Implement `src/s3-blobstore.ts`:**

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { BlobStore, UploadTarget, StoredBlob, ByteRange, CreateUploadTargetOpts, SignUrlOpts } from "@stackbase/blobstore";
import { makeS3Client } from "./s3-config";

export interface S3Config {
  bucket: string; region?: string; endpoint?: string;
  accessKeyId?: string; secretAccessKey?: string;
  forcePathStyle?: boolean; publicBaseUrl?: string;
}

async function toBuffer(bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (bytes instanceof Uint8Array) return bytes;
  const reader = bytes.getReader(); const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0); const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.byteLength; } return out;
}

export class S3BlobStore implements BlobStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBase?: string;
  constructor(config: S3Config) { this.s3 = makeS3Client(config); this.bucket = config.bucket; this.publicBase = config.publicBaseUrl; }

  async createUploadTarget(key: string, opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: opts.contentType });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: Math.ceil(opts.expiresInMs / 1000) });
    return { kind: "presigned", url, method: "PUT", headers: opts.contentType ? { "content-type": opts.contentType } : undefined };
  }

  async store(key: string, bytes: ReadableStream<Uint8Array> | Uint8Array, opts?: { contentType?: string }): Promise<StoredBlob> {
    const { createHash } = await import("node:crypto");
    const buf = await toBuffer(bytes);
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf, ContentType: opts?.contentType }));
    return { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    try { const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return { size: h.ContentLength ?? 0, sha256: null }; }
    catch { return null; }
  }

  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ""}` : undefined,
      }));
      if (!r.Body) return null;
      return Readable.toWeb(r.Body as Readable) as unknown as ReadableStream<Uint8Array>;
    } catch { return null; }
  }

  async delete(key: string): Promise<void> { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }

  async signGetUrl(key: string, opts: SignUrlOpts): Promise<string | null> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: Math.ceil(opts.expiresInMs / 1000) });
  }
  publicUrl(key: string): string | null { return this.publicBase ? `${this.publicBase.replace(/\/$/, "")}/${key}` : null; }
}
```

**Note:** `signGetUrl` is async across the whole seam (Task 1's interface already declares `Promise<string | null>`) because `@aws-sdk/s3-request-presigner`'s `getSignedUrl` returns a Promise. FS returns `Promise.resolve(null)`. This is why the deterministic `getUrl` (Task 6) never calls `signGetUrl` — signing happens only at the non-deterministic serve endpoint (Task 8).

- [ ] **Step 6: Bring up MinIO locally and run the gated conformance.** Run:

```bash
docker run -d --name sb-minio -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
# create the bucket (via the aws cli or mc); then:
STACKBASE_TEST_S3_ENDPOINT=http://localhost:9000 STACKBASE_TEST_S3_BUCKET=stackbase-test \
  bun run --filter @stackbase/blobstore-s3 test
```

Expected: PASS (7 conformance tests against real MinIO). Without the env var, the suite skips. `typecheck` clean. Stop/remove the container after.

- [ ] **Step 7: Commit.**

```bash
git add packages/blobstore-s3 pnpm-workspace.yaml package.json
git commit -m "feat(blobstore-s3): S3/R2 adapter — presigned direct-to-bucket path"
```

---

## Task 4: `_storage` system table + codegen `Id<"_storage">`

**Files:**
- Create: `packages/storage/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/system-table.ts`, `src/index.ts`
- Modify: `packages/codegen/src/generate.ts` (inject `_storage` into the emitted `DataModel`)
- Verify/Modify: `packages/id-codec/src/table-registry.ts` (reserve `_storage`'s system table number)
- Test: `packages/storage/test/system-table.test.ts`, `packages/codegen/test/system-tables.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // packages/storage/src/system-table.ts
  export const STORAGE_TABLE = "_storage";
  export const STORAGE_TABLE_NUMBER = 20;           // fixed reserved system-table number
  export const storageTableDefinition: TableDefinitionJSON; // schema for the _storage row
  ```
  The `_storage` row shape (matches the spec §4.3):
  `status: "pending"|"ready"`, `key: string`, `size: number|null`, `contentType: string|null`, `sha256: string|null`, `visibility: "private"|"public"`, `expiresAt: number|null`. (`_id`/`_creationTime` are auto-added by codegen, like every table.)

- [ ] **Step 1: Scaffold `packages/storage`.** `package.json` name `@stackbase/storage`, dependencies: `@stackbase/blobstore`, `@stackbase/values`, `@stackbase/executor`, `@stackbase/component`, `@stackbase/id-codec` (all `workspace:*`). tsup `entry: ["src/index.ts"]`. Copy tsconfig.

- [ ] **Step 2: Write `src/system-table.ts`.** Build `storageTableDefinition` with the project's schema builders (mirror how `components/scheduler/src/schema.ts` defines a table — read it and use the same `defineTable`/`v.*` API). The document validator has exactly the seven fields above; `size`/`contentType`/`sha256`/`expiresAt` are `v.union(v.number()/..., v.null())` (nullable, not optional — a pending row has them null). Export `STORAGE_TABLE`, `STORAGE_TABLE_NUMBER = 20`, `storageTableDefinition`.

- [ ] **Step 3: Reserve the table number.** Read `packages/id-codec/src/table-registry.ts`. `_storage` is `_`-prefixed so `isSystemTableName("_storage")` is already `true` and it draws from the 1–9999 system range. Confirm whether the registry auto-assigns (`nextSystem`) or needs an explicit reservation. If system tables are auto-numbered per registration, ensure `_storage` is registered **first/deterministically** so its number is stable across runs (a stored `Id` must decode the same table number forever). Add a test asserting `register("_storage")` yields a stable number and `isSystemTableName("_storage") === true`.

- [ ] **Step 4: Write the failing codegen test `packages/codegen/test/system-tables.test.ts`:**

```ts
import { describe, it, expect } from "vitest";
import { generateDataModel } from "../src/generate";

describe("codegen emits the _storage system table", () => {
  it("includes _storage in DataModel with its fields", () => {
    const schema = { tables: {} } as any; // an app with no user tables
    const out = generateDataModel(schema);
    expect(out.content).toContain("_storage:");
    expect(out.content).toContain("status:");
    expect(out.content).toContain('Id<"_storage">');
  });
});
```

- [ ] **Step 5: Run — verify it fails.** Run: `bun run --filter @stackbase/codegen test system-tables`
Expected: FAIL — `_storage` not present in generated output.

- [ ] **Step 6: Implement.** In `packages/codegen/src/generate.ts`, in `generateDataModel`, merge a fixed system-table set into `tables` before emitting: prepend an entry for `_storage` whose `documentType` is `storageTableDefinition.documentType`. To avoid `packages/codegen` depending on `packages/storage` (layering), define the `_storage` document validator inline in codegen as a `SYSTEM_TABLES` const (a small JSON validator literal — duplicated intentionally is worse than a shared const; put the canonical validator in `packages/values` or a tiny shared module both import). Chosen approach: add `export const SYSTEM_TABLE_DEFINITIONS: Record<string, ValidatorJSON>` to `packages/values` (already a dependency of both codegen and storage), and have both codegen and `packages/storage/src/system-table.ts` consume it. Update `generateDataModel`:

```ts
import { SYSTEM_TABLE_DEFINITIONS } from "@stackbase/values";
// ...
const userTables = Object.entries(schema.tables) as Array<[string, TableDefinitionJSON]>;
const systemEntries = Object.entries(SYSTEM_TABLE_DEFINITIONS).map(
  ([name, documentType]) => `  ${name}: { document: ${emitDocumentType(name, documentType)} };`,
);
const entries = [...systemEntries, ...userTables.map(([name, table]) => `  ${name}: { document: ${emitDocumentType(name, table.documentType)} };`)];
```

Add `SYSTEM_TABLE_DEFINITIONS` to `packages/values` with the `_storage` validator (the seven fields). This is the single source both codegen and the storage feature read.

- [ ] **Step 7: Run — verify pass.** Run: `bun run --filter @stackbase/codegen test system-tables && bun run --filter @stackbase/storage test`
Expected: PASS. `typecheck` clean for both.

- [ ] **Step 8: Commit.**

```bash
git add packages/storage packages/codegen packages/id-codec packages/values
git commit -m "feat(storage): _storage system table + codegen Id<\"_storage\">"
```

---

## Task 5: `packages/storage` internal metadata mutations

**Files:**
- Create: `packages/storage/src/modules.ts`
- Test: `packages/storage/test/modules.test.ts`

**Interfaces:**
- Consumes: `STORAGE_TABLE` from `./system-table`; the executor's mutation/module shapes (mirror `components/scheduler/src/modules.ts`).
- Produces internal mutations (all operate on the app-root `_storage` table, privileged):
  ```ts
  export const _createPending;  // args {key, contentType, visibility, expiresAt} -> returns storageId (string)
  export const _insertReady;    // args {key, size, sha256, contentType, visibility} -> returns storageId
  export const _finalize;       // args {id, size, sha256} -> flips status "pending"->"ready", sets size/sha256
  export const _delete;         // args {id} -> deletes the row, returns {key}
  export const _reapExpired;    // args {now} -> deletes pending rows past expiresAt, returns {keys: string[]}
  export const _get;            // query args {id} -> the _storage doc or null
  export const storageModules;  // { "_storage:_createPending": _createPending, ... }
  ```

- [ ] **Step 1: Write the failing test `test/modules.test.ts`.** Use the same in-memory executor/runtime harness the scheduler's module tests use (read `components/scheduler/test/*` for the exact harness). Assert: `_createPending` inserts a `status:"pending"` row and returns an id decoding to table `_storage`; `_finalize` flips it to `ready` with size/sha256; `_insertReady` inserts a ready row directly; `_reapExpired` with `now` past `expiresAt` removes the pending row and returns its key; `_delete` removes a row and returns its key.

- [ ] **Step 2: Run — verify it fails** (module file absent). Run: `bun run --filter @stackbase/storage test modules`. Expected: FAIL.

- [ ] **Step 3: Implement `src/modules.ts`** mirroring `components/scheduler/src/modules.ts` (same `mutation(...)`/`query(...)` builders, same `ctx.db` API). Each writes/reads `STORAGE_TABLE`. `_reapExpired` queries `_storage` by creation index, filters `status === "pending" && expiresAt !== null && expiresAt <= now`, collects keys, deletes those rows, returns `{ keys }`.

- [ ] **Step 4: Run — verify pass.** Run: `bun run --filter @stackbase/storage test modules`. Expected: PASS. typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add packages/storage/src/modules.ts packages/storage/test/modules.test.ts
git commit -m "feat(storage): internal _storage metadata mutations"
```

---

## Task 6: `ctx.storage` context provider (build + buildAction)

**Files:**
- Create: `packages/storage/src/context.ts`
- Test: `packages/storage/test/context.test.ts`

**Interfaces:**
- Consumes: `ContextProvider`, `ComponentContext`, `ActionApi` from `@stackbase/executor`; `BlobStore` from `@stackbase/blobstore`; the internal modules from `./modules`; `STORAGE_TABLE` from `./system-table`.
- Produces:
  ```ts
  export function storageContextProvider(blobStore: BlobStore, opts?: { uploadTtlMs?: number }): ContextProvider;
  // name: "storage", namespace: "", write: true
  // build(cctx) -> { generateUploadUrl, getUrl, getMetadata, delete }
  // buildAction(api) -> { store, get }
  ```
  App-facing `ctx.storage` shape (both mutation and action modes expose the SAME method names where applicable):
  ```ts
  interface StorageWriter {  // build() — query/mutation
    generateUploadUrl(opts?: { contentType?: string; visibility?: "private" | "public" }): Promise<{ storageId: string; target: UploadTarget }>;
    getUrl(id: string): Promise<string | null>;
    getMetadata(id: string): Promise<BlobMetadata | null>;
    delete(id: string): Promise<void>;
  }
  interface StorageActions extends /* getUrl/getMetadata */ {  // buildAction() — action
    store(bytes: Uint8Array | ReadableStream<Uint8Array>, opts?: { contentType?: string; visibility?: "private" | "public" }): Promise<string>;
    get(id: string): Promise<ReadableStream<Uint8Array> | null>;
  }
  ```

- [ ] **Step 1: Write the failing test `test/context.test.ts`.** Using the runtime harness, register the storage provider with a `MemoryBlobStore`. Assert:
  - In a **mutation**, `ctx.storage.generateUploadUrl({ contentType: "text/plain" })` returns `{ storageId, target: { kind: "proxied", ... } }` and a `pending` `_storage` row exists with a future `expiresAt`.
  - In a **mutation**, `ctx.storage.getUrl(id)` for a private file returns `/api/storage/<id>`.
  - In an **action**, `ctx.storage.store(bytes, { contentType })` writes bytes to the blob store AND inserts a `ready` `_storage` row, returning its id; `ctx.storage.get(id)` streams the bytes back.

- [ ] **Step 2: Run — verify it fails.** Run: `bun run --filter @stackbase/storage test context`. Expected: FAIL.

- [ ] **Step 3: Implement `src/context.ts`.** Mirror `components/scheduler/src/facade.ts` (which shows `schedulerContext(cctx)` using `cctx.db` writes + `schedulerActionContext(api)` delegating to `api.runMutation`). Key mechanics:
  - **Key generation:** `const key = crypto.randomUUID();` — but a mutation must be deterministic. Generate the key deterministically from the transaction: use the executor's seeded RNG exposed on `cctx` (the same seed mechanism scheduler uses for deterministic ids) or derive it from the new row's `Id` after insert. Chosen approach: `_createPending` returns the inserted row's `Id`; use `id` itself as the storage `key` (ids are unique, deterministic within the transaction, and never reused). So `key === storageId`. This sidesteps non-deterministic UUIDs entirely.
  - **`generateUploadUrl`** (build): call `cctx`'s storage-write path — insert the pending row via the `_createPending` logic (write through `cctx.db` directly, since `write:true`), compute `expiresAt = cctx.now + (opts.uploadTtlMs ?? 3_600_000)`, then `const target = await blobStore.createUploadTarget(key, { contentType, expiresInMs, now: cctx.now })`. For a `proxied` target, append the capability token to the url (`?id=<id>&token=<sig>` — token = a signature over `{id, exp}` with the deployment key, computed with `cctx.now`; deterministic). Return `{ storageId: key, target }`.
  - **`getUrl`** (build): read the row; if missing → `null`; if `visibility === "public"` → `blobStore.publicUrl(row.key)` (may be null → fall back to endpoint); else → `/api/storage/${id}`.
  - **`getMetadata`** (build): read the row → `{ size, contentType, sha256 }` or null.
  - **`delete`** (build): delete the row via `cctx.db` (transactional tombstone); the physical blob is reclaimed by the reaper (Task 9). Do NOT call `blobStore.delete` here (byte I/O can't run in the transactor).
  - **`store`** (buildAction): `const info = await blobStore.store(key, bytes, { contentType })` where `key` is a fresh id obtained via `api.runMutation("_storage:_createPending", ...)` OR insert-ready in one shot: call `api.runMutation("_storage:_insertReady", { key, size, sha256, contentType, visibility })`. To get a key before the row exists, run `_createPending` first (returns id=key), store bytes, then `_finalize`. Chosen: `store` = `_createPending` → `blobStore.store(key,…)` → `_finalize(id,size,sha256)` → return id. All metadata writes go through `api.runMutation` (actions have no `db`).
  - **`get`** (buildAction): read the row via `api.runQuery("_storage:_get", {id})` → `blobStore.read(row.key)`.
  - Provider fields: `{ name: "storage", namespace: "", write: true, build, buildAction }`.

- [ ] **Step 4: Run — verify pass.** Run: `bun run --filter @stackbase/storage test context`. Expected: PASS. typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add packages/storage/src/context.ts packages/storage/test/context.test.ts
git commit -m "feat(storage): ctx.storage context provider (metadata syscall + native byte I/O)"
```

---

## Task 7: Upload / confirm / serve HTTP endpoints

**Files:**
- Create: `packages/storage/src/http.ts`
- Test: `packages/storage/test/http.test.ts`

**Interfaces:**
- Consumes: `BlobStore`; the internal modules; the HTTP route shape (`ResolvedRoute` — read `packages/cli/src/server.ts` and `packages/executor/src/http-router.ts` for the exact `{ method, path, handler(request, ctx) }` type the engine dispatches).
- Produces:
  ```ts
  export function storageRoutes(blobStore: BlobStore, deps: {
    runMutation(path: string, args: any): Promise<any>;
    runQuery(path: string, args: any): Promise<any>;
    verifyToken(token: string, id: string, now: number): boolean;
  }): ResolvedRoute[];
  // POST /api/storage/upload   (proxied): validate token -> store bytes -> _finalize -> {storageId}
  // POST /api/storage/confirm  (direct):  validate token -> finalizeUpload -> _finalize -> {storageId}
  // GET  /api/storage/:id       (serve):  load row -> stream via read() (Range) | 302 signGetUrl | publicUrl
  ```

- [ ] **Step 1: Write the failing test `test/http.test.ts`.** Drive the three handlers directly (no server needed) against a `MemoryBlobStore` + an in-memory metadata layer:
  - `POST /api/storage/upload?id=<id>&token=<t>` with a `Request` whose body is bytes → 200 `{ storageId }`; the row is `ready`; the bytes are in the blob store.
  - `POST /api/storage/confirm` for a key pre-populated in the blob store → 200 `{ storageId }`, row `ready`.
  - `GET /api/storage/<id>` for a `ready` public/no-authz file → 200 with the bytes; a `Range: bytes=2-5` request → 206 with the partial bytes and a `Content-Range` header.
  - `GET /api/storage/<missing>` → 404.

- [ ] **Step 2: Run — verify it fails.** Run: `bun run --filter @stackbase/storage test http`. Expected: FAIL.

- [ ] **Step 3: Implement `src/http.ts`.** Each handler takes the raw `Request` and returns a `Response` (the `httpAction` I/O shape — read `packages/executor/src/functions.ts` for the exact handler signature). Upload: parse `id`/`token` from the query, `verifyToken`, read `await request.arrayBuffer()` → `Uint8Array`, `blobStore.store(id, bytes, { contentType: request.headers.get("content-type") ?? undefined })`, `runMutation("_storage:_finalize", { id, size, sha256 })`, return `Response.json({ storageId: id })`. Confirm: same but `blobStore.finalizeUpload(id)` (null → 409 "upload not found"). Serve: `runQuery("_storage:_get", { id })` (404 if null/`pending`), then Range handling: parse `Range` header → `blobStore.read(key, range)` → 206 with `Content-Range`/`Accept-Ranges`; no range → `read(key)` → 200. (Authz + the public/signed-redirect branch land in Task 8; here, serve everything that exists.)

- [ ] **Step 4: Run — verify pass.** Run: `bun run --filter @stackbase/storage test http`. Expected: PASS. typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add packages/storage/src/http.ts packages/storage/test/http.test.ts
git commit -m "feat(storage): upload/confirm/serve reserved HTTP endpoints (+ Range)"
```

---

## Task 8: Serve-endpoint access control (authz reuse) + private/public

**Files:**
- Modify: `packages/storage/src/http.ts` (the serve handler)
- Test: `packages/storage/test/serve-authz.test.ts`

**Interfaces:**
- Consumes: the `authz` effective-permissions check. Read `components/authz` for the exact call that resolves whether an `identity` may read a given table row (the same engine that gates `ctx.db` reads). The serve handler gains a `checkRead(identity, table, id): Promise<boolean>` dep.
- Produces: the serve handler now (a) for `visibility:"private"`, requires `checkRead` to pass (403 otherwise); (b) for `visibility:"public"`, if `blobStore.publicUrl(key)` is non-null, 302-redirect to it; (c) for private S3-backed files, if `blobStore.signGetUrl(key, …)` is non-null, 302-redirect to the signed GET; else stream.

- [ ] **Step 1: Write the failing test `test/serve-authz.test.ts`.** Assert:
  - Private file + `checkRead` returns `false` → `GET /api/storage/:id` → 403, no bytes.
  - Private file + `checkRead` returns `true` → 200 with bytes.
  - Public file with a `publicUrl` backend → 302 to the public url.
  - Private file with a `signGetUrl` backend (a fake returning a url) → 302 to the signed url.
  - Fallback when `checkRead` is undefined (authz not composed): a signed capability token in the request grants access; absent/invalid token → 403. (Graceful degradation — never fail open.)

- [ ] **Step 2: Run — verify it fails.** Run: `bun run --filter @stackbase/storage test serve-authz`. Expected: FAIL.

- [ ] **Step 3: Implement.** Extend the serve handler: after loading the `ready` row, branch on `visibility`. Private → run `checkRead(identity, "_storage", id)` (identity from the request's `Authorization: Bearer` header, passed straight through — same convention as `httpAction`); on false, `new Response("forbidden", { status: 403 })`. Then prefer redirects: `const pub = row.visibility === "public" ? blobStore.publicUrl(row.key) : null;` `const signed = row.visibility === "private" ? await blobStore.signGetUrl(row.key, { expiresInMs: 60_000, now: Date.now() }) : null;` (this handler is a non-deterministic httpAction, so wall-clock `Date.now()` is allowed here — unlike the deterministic `getUrl`). If `pub || signed`, return a 302 to it; else stream via `read()` as in Task 7. When `checkRead` is undefined, require and verify the capability token instead.

- [ ] **Step 4: Run — verify pass.** Run: `bun run --filter @stackbase/storage test`. Expected: PASS (all storage unit suites). typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add packages/storage/src/http.ts packages/storage/test/serve-authz.test.ts
git commit -m "feat(storage): private-by-default serving — authz reuse + signed/public redirects"
```

---

## Task 9: The orphan-reaper driver

**Files:**
- Create: `packages/storage/src/reaper.ts`
- Test: `packages/storage/test/reaper.test.ts`

**Interfaces:**
- Consumes: `Driver`/`DriverContext` from `@stackbase/component` (`runFunction`/`onCommit`/`setTimer`); `BlobStore`; the `_reapExpired` module.
- Produces:
  ```ts
  export function storageReaper(blobStore: BlobStore, opts?: { sweepMs?: number }): Driver;
  ```
  On start: arm a periodic `setTimer` (default 60_000ms). Each tick: `const { keys } = await driverCtx.runFunction("_storage:_reapExpired", { now });` then `for (const k of keys) await blobStore.delete(k);` then re-arm. `onCommit` is not required for correctness (TTL is time-based), but subscribe to re-arm the timer promptly after commits touching `_storage` so a just-expired batch is swept without waiting a full interval.

- [ ] **Step 1: Write the failing test `test/reaper.test.ts`.** Mirror `components/scheduler/test/driver*.test.ts`'s fake `DriverContext` (a manual clock + a `runFunction` that dispatches to the real modules). Assert: create a `pending` row with `expiresAt` in the past + put its blob in a `MemoryBlobStore`; advance the fake timer one tick; the row is gone AND `blobStore.read(key)` is null. A `ready` row is never reaped.

- [ ] **Step 2: Run — verify it fails.** Run: `bun run --filter @stackbase/storage test reaper`. Expected: FAIL.

- [ ] **Step 3: Implement `src/reaper.ts`** mirroring `components/scheduler/src/driver.ts` (its `start(ctx)` returns a stop fn; it arms `setTimer` and re-arms on `onCommit`). The reaper's tick calls `_reapExpired` then deletes the returned keys' blobs natively.

- [ ] **Step 4: Run — verify pass.** Run: `bun run --filter @stackbase/storage test reaper`. Expected: PASS. typecheck clean.

- [ ] **Step 5: Wire `src/index.ts`** to export the public surface: `storageContextProvider`, `storageReaper`, `storageRoutes`, `storageModules`, `STORAGE_TABLE`, `STORAGE_TABLE_NUMBER`, `storageTableDefinition`. Commit.

```bash
git add packages/storage/src/reaper.ts packages/storage/test/reaper.test.ts packages/storage/src/index.ts
git commit -m "feat(storage): orphan-reaper driver (TTL sweep + native blob delete)"
```

---

## Task 10: Backend selection + always-wire the storage feature in boot

**Files:**
- Modify: `packages/cli/src/boot.ts` (`makeBlobStore` + wire storage into `bootLoaded`)
- Create: `packages/cli/src/blobstore-select.ts` (`makeBlobStore` + `isS3Config` — pure, testable)
- Test: `packages/cli/test/blobstore-select.test.ts`

**Interfaces:**
- Consumes: `FsBlobStore`, `S3BlobStore`, and the storage feature exports; `makeStore`'s pattern in `boot.ts` (the DocStore analog).
- Produces:
  ```ts
  export interface BlobStoreOptions { dataPath: string; storage?: Partial<S3Config> & { bucket?: string } }
  export function isS3Config(o: BlobStoreOptions["storage"]): boolean; // true iff a bucket is set
  export function makeBlobStore(o: BlobStoreOptions): BlobStore;        // S3 if isS3Config else FsBlobStore
  ```
  `bootLoaded` prepends the storage wiring to the composed project: `contextProviders = [storageContextProvider(blobStore), ...project.contextProviders]`, `drivers = [storageReaper(blobStore), ...project.drivers]`, register `STORAGE_TABLE_NUMBER` in `tableNumbers`, and prepend `storageRoutes(blobStore, deps)` to the routes handed to the server. This runs unconditionally (storage is core, not read from `stackbase.config.ts`).

- [ ] **Step 1: Write the failing test `test/blobstore-select.test.ts`:**

```ts
import { describe, it, expect } from "vitest";
import { isS3Config, makeBlobStore } from "../src/blobstore-select";
import { FsBlobStore } from "@stackbase/blobstore-fs";
import { S3BlobStore } from "@stackbase/blobstore-s3";

describe("makeBlobStore selection", () => {
  it("defaults to FS when no bucket configured", () => {
    expect(isS3Config(undefined)).toBe(false);
    expect(makeBlobStore({ dataPath: "/tmp/x" })).toBeInstanceOf(FsBlobStore);
  });
  it("selects S3 when a bucket is configured", () => {
    expect(isS3Config({ bucket: "b" })).toBe(true);
    expect(makeBlobStore({ dataPath: "/tmp/x", storage: { bucket: "b", endpoint: "http://localhost:9000" } })).toBeInstanceOf(S3BlobStore);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `bun run --filter @stackbase/cli test blobstore-select`. Expected: FAIL.

- [ ] **Step 3: Implement `src/blobstore-select.ts`.** `isS3Config` = `Boolean(o?.bucket)`. `makeBlobStore` = S3 (`new S3BlobStore({ bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle, publicBaseUrl })`) when `isS3Config`, else `new FsBlobStore({ root: join(o.dataPath, "storage") })`. Read S3 fields from env in `boot.ts`: `STACKBASE_STORAGE_BUCKET`, `STACKBASE_STORAGE_ENDPOINT`, `STACKBASE_STORAGE_REGION`, `STACKBASE_STORAGE_PUBLIC_URL`, plus standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, and a `--storage-bucket`/`--storage-endpoint` CLI flag set (flag wins over env, mirroring `--database-url`).

- [ ] **Step 4: Run — verify pass.** Run: `bun run --filter @stackbase/cli test blobstore-select`. Expected: PASS.

- [ ] **Step 5: Wire into `bootLoaded`.** Add `makeBlobStore` to the boot core; prepend the storage `contextProviders`/`drivers`/`tableNumbers`/routes as described in Interfaces. The `storageRoutes` deps' `runMutation`/`runQuery` bind to the runtime's privileged invoke (the same path `_admin` modules use); `verifyToken`/`checkRead` bind to the deployment key + authz. Add a boot smoke test (extend an existing `boot` test): a runtime booted with a temp `dataPath` exposes `ctx.storage` in a mutation and serves `GET /api/storage/:id`. Run the CLI suite: `bun run --filter @stackbase/cli test`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/cli/src/boot.ts packages/cli/src/blobstore-select.ts packages/cli/test/blobstore-select.test.ts
git commit -m "feat(cli): makeBlobStore backend selection + always-on storage wiring"
```

---

## Task 11: E2E ship gate — FS hermetic + MinIO container, through real `stackbase serve`

**Files:**
- Create: `packages/cli/test/storage-e2e.test.ts`
- Test fixture: a minimal `convex/` under `packages/cli/test/fixtures/storage-app/` with a `files` table holding `image: v.id("_storage")`, a `saveImage` mutation, and a `listImages` query.

**Interfaces:**
- Consumes: the real `stackbase serve` boot (`bootLoaded`/`startDevServer`), a WebSocket client (mirror `packages/cli/test/postgres-e2e.test.ts` / `action-e2e.test.ts` structure), and the Docker MinIO container helper (mirror how `postgres-e2e.test.ts` runs `postgres:16`).

- [ ] **Step 1: Write the FS hermetic E2E** (no container). Boot `serve` with a temp `dataPath` (FS backend). Through the real server:
  1. `ctx.storage.generateUploadUrl` via a mutation call → get `{ storageId, target }` (proxied).
  2. `POST` bytes to `target.url` → 200.
  3. Call `saveImage({ storageId })` (stores `Id<"_storage">` in a `files` row) — assert it commits.
  4. A `listImages` **subscription opened before step 3** receives the update (reactive fan-out through `_storage` + `files`).
  5. `getUrl(storageId)` → `/api/storage/<id>`; `GET` it → 200 with the original bytes.

- [ ] **Step 2: Run the FS E2E — verify pass.** Run: `bun run --filter @stackbase/cli test storage-e2e`. Expected: PASS (FS assertions).

- [ ] **Step 3: Add the MinIO container E2E** (the ship gate), gated to run when Docker is available (mirror the postgres E2E's container guard). Bring up `minio/minio`, create the bucket, boot `serve` with `STACKBASE_STORAGE_BUCKET`/`STACKBASE_STORAGE_ENDPOINT` pointed at it. Assert:
  1. `generateUploadUrl` returns a **presigned** target; `PUT` bytes directly to the bucket url (never through the server).
  2. `POST /api/storage/confirm` → row flips `ready`.
  3. `getUrl` → serve endpoint; `GET` → 302 to a signed bucket GET (or streamed bytes) returning the original content.
  4. Store the `Id<"_storage">` in a `files` row → a pre-opened `listImages` subscription updates.
  5. **Orphan reap:** `generateUploadUrl` (presigned) but never confirm; force the reaper tick (or set a tiny `uploadTtlMs`/`sweepMs` for the test); assert the pending row is gone and the bucket object (if the client had PUT it) is deleted.
  6. `ctx.storage.delete(id)` on a confirmed file → row gone; after a reaper tick the bucket object is gone.

- [ ] **Step 4: Run the full E2E — verify pass.** Run: `bun run --filter @stackbase/cli test storage-e2e` (with Docker running). Expected: PASS (FS + MinIO). Tear down the container.

- [ ] **Step 5: Commit.**

```bash
git add packages/cli/test/storage-e2e.test.ts packages/cli/test/fixtures/storage-app
git commit -m "test(cli): file-storage E2E — FS hermetic + MinIO container through real serve"
```

---

## Task 12: Docs, dashboard browse, and status

**Files:**
- Create: `docs/enduser/files.md` (or the section under `configure/`) — file storage guide
- Modify: `apps/dashboard/...` — surface `_storage` in the data browser (it's a system table; ensure it's listable/browsable)
- Modify: `CLAUDE.md` and `README.md` — mark slice 4 shipped, add file storage to "what works" + the `--storage-*` flags
- Test: `packages/cli/test/docker-config.test.ts` (or a small guard test) asserting the docs reference real packages (`@stackbase/blobstore-fs`/`-s3`, not the retired `@stackbase/blobstore-bun-fs` phantom names)

- [ ] **Step 1: Write `docs/enduser/files.md`** — the end-user guide: `ctx.storage.generateUploadUrl` from a mutation, upload from the client (handling both `proxied` and `presigned` `target.kind` transparently), storing `Id<"_storage">` in a document, `getUrl`/`getMetadata`, `ctx.storage.store`/`get` from actions, private-vs-public visibility, and the `--storage-bucket`/`STACKBASE_STORAGE_*` config for S3/R2. Include the "same app code on FS and S3" framing.

- [ ] **Step 2: Dashboard browse.** Confirm the data browser lists `_storage` (system tables may be filtered today — read `apps/dashboard` + `_admin:browseTable`). If system tables are hidden, add `_storage` to the allowed/visible set so uploaded files are inspectable. Add/extend a test if the browser has one.

- [ ] **Step 3: Update `CLAUDE.md` + `README.md`.** Add file storage to the "What works" list (the `BlobStore` seam + fs/s3 adapters + `_storage`/`ctx.storage` + two-phase uploads + reaper + MinIO E2E); move it out of "deferred"; add the `--storage-*` flags to the CLI/storage section; note slice 4 is shipped.

- [ ] **Step 4: Write the docs-reference guard test.** Assert no doc references a non-existent `@stackbase/blobstore-bun-*`/`cf-r2` phantom package name, and that `docs/enduser/files.md` references `@stackbase/blobstore-fs`/`@stackbase/blobstore-s3`. Run: `bun run --filter @stackbase/cli test`. Expected: PASS.

- [ ] **Step 5: Full suite + build + typecheck.** Run: `bun run build && bun run typecheck && bun run test`. Expected: all green. Commit.

```bash
git add docs CLAUDE.md README.md apps/dashboard packages/cli/test
git commit -m "docs(storage): file storage guide + dashboard browse + slice 4 shipped"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §3 core-built-in + adapter-packages decision → Tasks 1–3 (packages), 4/10 (core wiring).
- §4.1 packages → Tasks 1,2,3,4/5.
- §4.2 `BlobStore` seam → Task 1.
- §4.3 `_storage` table + `Id<"_storage">` → Task 4.
- §4.4 `ctx.storage` tiering → Task 6.
- §4.5 `generateUploadUrl`-deterministic → Task 6 (Step 3, id-as-key + `cctx.now`) + Global Constraints.
- §4.6 backend selection → Task 10.
- §5 upload flows (proxied + presigned + confirm) → Tasks 6,7 + E2E 11.
- §6 serving/authz/CDN/Range → Tasks 7 (Range) + 8 (authz/public/signed).
- §7 reaper/orphans/delete → Task 9 + E2E 11.
- §8 error handling → covered across 7 (404/409), 8 (403), 10 (fail-fast unwritable dir — add to Task 10 boot), 3 (S3 errors thrown).
- §9 testing (conformance + MinIO gate) → Tasks 1 (suite), 2/3 (adapters run it), 11 (ship gate).
- §10 scope/deferred → nothing built for TUS/transforms/dedup (correctly absent).
- §11 success criteria → E2E 11 asserts 1–5; Global Constraints + Task 10 assert 6 (no leak / no S3 dep in FS build).
- §12 resolved questions → all reflected (sha256-null-direct in Task 2/3; confirm endpoint Task 7; reaper Task 9; private-default Task 8; async blob delete Task 9; Range Task 7; S3 in-slice Task 3/11; native-path-default Task 6).

*Gap found + fixed:* §8 "fail fast on unwritable FS dir / missing backend" — fold a fail-fast check into Task 10 Step 5 (verify the FS `storage/` dir is creatable/writable at boot; throw a clear operator error otherwise).

**2. Placeholder scan** — no "TBD"/"handle edge cases"/"similar to Task N". The `signGetUrl`-async correction (Task 3 Step 5 note) is a concrete instruction to change Task 1's signature, not a placeholder. The "read `components/scheduler/...` for the exact harness/API" pointers are grounding directions (the analog exists and is named), not deferrals — each is paired with the exact interface to produce.

**3. Type consistency** — `BlobStore` method names (`createUploadTarget`/`store`/`finalizeUpload`/`read`/`delete`/`signGetUrl`/`publicUrl`), `StoredBlob{size,sha256}`, `UploadTarget{kind,url,method,headers?}`, `_storage` fields (`status/key/size/contentType/sha256/visibility/expiresAt`), internal module names (`_createPending/_insertReady/_finalize/_delete/_reapExpired/_get`), route paths (`/api/storage/upload|confirm|:id`), and boot helpers (`makeBlobStore/isS3Config`) are used identically across Tasks 1→12. `signGetUrl` is `Promise<string|null>` uniformly from Task 1 onward (async because the S3 presigner is async), so no mid-plan signature change is needed.
