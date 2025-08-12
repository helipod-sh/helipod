/**
 * Slice 4 (file storage) SHIP GATE — proves the whole feature works through the REAL `stackbase
 * serve` server, on BOTH byte backends:
 *
 *   • FS (hermetic, no container): the zero-config proxied-upload path — `generateUploadUrl` →
 *     `POST` bytes to our own `/api/storage/upload` endpoint → row flips `ready` → `getUrl` →
 *     `GET` the bytes (200 + Range 206) → `delete`.
 *   • S3 (the ship gate): a REAL `minio/minio` container — the presigned direct-to-bucket path:
 *     `generateUploadUrl` → `PUT` straight to the bucket (never through our server) →
 *     `POST /api/storage/confirm` → `getUrl` → follow the 302 to the signed bucket GET → orphan
 *     reap → `delete` blob reclaim. Gated on Docker like `postgres-e2e.test.ts`.
 *
 * Both boot the real `startServe` (the production entry `serve-e2e.test.ts` uses) against an
 * on-disk fixture `convex/` dir with a `files` table holding `image: v.id("_storage")`, and both
 * assert the reactive path: a `files:list` subscription opened BEFORE `files:save` sees the new
 * row (an `Id<"_storage">` in a user doc fanning out like any other write).
 *
 * Binary-safety is load-bearing here: the uploaded bytes include NON-UTF8 values (a fake PNG
 * header + high bytes), and the served bytes are asserted BYTE-IDENTICAL — this is the exact
 * property the Task-10 "binary-safe proxied uploads on Node" fix protects, which a text-only
 * payload would silently pass even if regressed.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { startServe } from "../src/serve";
import { S3BlobStore } from "@stackbase/blobstore-s3";

/* -------------------------------------------------------------------------- */
/* Shared: the storage-app fixture, WS helpers, byte assertions                */
/* -------------------------------------------------------------------------- */

/** The committed fixture convex dir (schema.ts + files.ts + _generated). Copied into a temp dir per
 * run so a fresh `node_modules/@stackbase` symlink can resolve the bare `@stackbase/*` imports the
 * dynamic `loadConvexDir` import needs (mirrors `serve-e2e.test.ts`). */
function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

function makeFixtureConvexDir(): string {
  const src = resolve(new URL(".", import.meta.url).pathname, "fixtures", "storage-app", "convex");
  const root = mkdtempSync(join(tmpdir(), "sb-storage-e2e-"));
  const dir = join(root, "convex");
  cpSync(src, dir, { recursive: true });
  const nm = join(dir, "node_modules");
  mkdirSync(nm);
  symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));
  return dir;
}

/** A fake-PNG payload with deliberately non-UTF8 bytes (0xFF/0x00/0xFE/0x80/high) — the binary
 * fidelity probe. */
const BINARY = new Uint8Array([0xff, 0x00, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x80, 0x01, 0x02, 0x7f, 0xc3, 0x28]);

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolvePromise(ws));
    ws.once("error", reject);
  });
}

type ServerMsg = {
  type: string;
  modifications?: Array<{ type: string; queryId: number; value?: unknown; error?: string }>;
};

function collectMessages(ws: WebSocket): ServerMsg[] {
  const messages: ServerMsg[] = [];
  ws.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString("utf8")) as ServerMsg));
  return messages;
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 15));
  }
}

function latestMod(
  messages: ServerMsg[],
  queryId: number,
): { type: string; queryId: number; value?: unknown; error?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const mods = messages[i]?.modifications ?? [];
    for (let j = mods.length - 1; j >= 0; j--) {
      const m = mods[j];
      if (m !== undefined && m.queryId === queryId) return m;
    }
  }
  return undefined;
}

/** Subscribe to `files:list` and await the initial `QueryUpdated`. */
async function subscribeToFiles(wsUrl: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "files:list", args: {} }], remove: [] });
  await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
  return { ws, messages };
}

/** `POST /api/run` a function and return its raw JSON body. */
async function run<T = unknown>(baseUrl: string, path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  if (res.status !== 200) throw new Error(`run ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

type UploadTarget = { kind: "proxied" | "presigned"; url: string; method: string; headers?: Record<string, string>; confirmUrl?: string };
type CreateUploadResult = { value: { storageId: string; target: UploadTarget } };

/** Absolute-ify an engine-relative url (`/api/...`) against the server origin. */
function abs(baseUrl: string, maybeRelative: string): string {
  return maybeRelative.startsWith("http") ? maybeRelative : `${baseUrl}${maybeRelative}`;
}

/* -------------------------------------------------------------------------- */
/* FS hermetic E2E (no container)                                             */
/* -------------------------------------------------------------------------- */

describe("file storage — FS hermetic E2E (real serve, proxied upload path)", () => {
  it("upload (binary) → ready + reactive fan-out → getUrl GET (200 + Range 206) → delete", async () => {
    const convexDir = makeFixtureConvexDir();
    const dataPath = join(mkdtempSync(join(tmpdir(), "sb-storage-fs-db-")), "db.sqlite");

    const { server, store } = await startServe({
      convexDir,
      dataPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "fs-key",
      dashboard: false,
      allowDeploy: false,
      // Short reaper sweep so the delete tombstone (below) is reclaimed within the test.
      storageReaperSweepMs: 200,
    });

    try {
      const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

      /* 1. generateUploadUrl → a PROXIED target. */
      const { value: up } = await run<CreateUploadResult>(server.url, "files:createUpload", {
        contentType: "image/png",
        visibility: "private",
      });
      expect(up.target.kind).toBe("proxied");
      const storageId = up.storageId;

      /* 2. POST the raw binary bytes to the proxied endpoint the server itself minted. */
      const uploadRes = await fetch(abs(server.url, up.target.url), {
        method: up.target.method,
        headers: { "content-type": "image/png" },
        body: BINARY,
      });
      expect(uploadRes.status).toBe(200);
      expect((await uploadRes.json()) as { storageId: string }).toEqual({ storageId });

      /* 3. Subscribe to files:list BEFORE the save → sees [] first. */
      const { ws, messages } = await subscribeToFiles(wsUrl);
      expect(latestMod(messages, 1)!.value).toEqual([]);

      /* 4. save({name, storageId}) — an Id<"_storage"> lands in a user `files` row and fans out. */
      await run(server.url, "files:save", { name: "logo.png", storageId });
      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length > 0;
      });
      expect(latestMod(messages, 1)!.value).toEqual([{ name: "logo.png", image: storageId }]);
      ws.close();

      /* 5. getUrl → GET the bytes back, BYTE-IDENTICAL to what we uploaded. */
      const { value: getUrl } = await run<{ value: string }>(server.url, "files:getUrl", { id: storageId });
      expect(getUrl).not.toBeNull();
      const getRes = await fetch(abs(server.url, getUrl));
      expect(getRes.status).toBe(200);
      const served = new Uint8Array(await getRes.arrayBuffer());
      expect(Array.from(served)).toEqual(Array.from(BINARY));

      /* 5b. A Range request → 206 with the correct partial bytes. */
      const rangeRes = await fetch(abs(server.url, getUrl), { headers: { range: "bytes=2-5" } });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe(`bytes 2-5/${BINARY.length}`);
      const partial = new Uint8Array(await rangeRes.arrayBuffer());
      expect(Array.from(partial)).toEqual(Array.from(BINARY.slice(2, 6)));

      /* 6. delete → tombstone → the reaper reclaims the row (and the FS blob). */
      await run(server.url, "files:remove", { id: storageId });
      await waitForAsync(async () => {
        const { value } = await run<{ value: unknown }>(server.url, "files:getMeta", { id: storageId });
        return value === null;
      }, 20_000);
      const { value: metaAfter } = await run<{ value: unknown }>(server.url, "files:getMeta", { id: storageId });
      expect(metaAfter).toBeNull();
    } finally {
      await server.close();
      store.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* MinIO container E2E (the ship gate) — presigned direct path                */
/* -------------------------------------------------------------------------- */

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();
const maybeDescribe = HAS_DOCKER ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-e2e-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-e2e";

function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Resolve `@aws-sdk/client-s3` from `@stackbase/blobstore-s3`'s own node_modules (it isn't a
 * direct `@stackbase/cli` dependency, but the S3 adapter carries it). Used only for bucket
 * creation — read/delete assertions go through the shipped `S3BlobStore`. */
function loadS3Sdk(): { S3Client: any; CreateBucketCommand: any } {
  const reqRoot = createRequire(import.meta.url);
  const reqS3 = createRequire(reqRoot.resolve("@stackbase/blobstore-s3"));
  return reqS3("@aws-sdk/client-s3");
}

async function startMinio(): Promise<{ endpoint: string }> {
  runDocker(["rm", "-f", MINIO_CONTAINER]);
  const run = runDocker([
    "run",
    "-d",
    "--name",
    MINIO_CONTAINER,
    "-e",
    `MINIO_ROOT_USER=${MINIO_USER}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${MINIO_PASS}`,
    "-p",
    "127.0.0.1::9000",
    "minio/minio",
    "server",
    "/data",
  ]);
  if (run.status !== 0) throw new Error(`docker run minio failed: ${run.stderr}`);

  const portRes = runDocker(["port", MINIO_CONTAINER, "9000/tcp"]);
  const line = portRes.stdout.trim().split("\n")[0] ?? "";
  const m = line.match(/:(\d+)$/);
  if (!m) throw new Error(`could not parse minio \`docker port\`: ${JSON.stringify(portRes.stdout)}`);
  const endpoint = `http://127.0.0.1:${m[1]}`;

  // Wait for readiness, then create the bucket via the S3 API.
  const { S3Client, CreateBucketCommand } = loadS3Sdk();
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASS },
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      break;
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") break;
      if (Date.now() > deadline) throw new Error(`minio not ready / bucket create failed: ${String(e)}`);
      await new Promise<void>((r) => setTimeout(r, 500));
    }
  }
  return { endpoint };
}

function stopMinio(): void {
  runDocker(["rm", "-f", MINIO_CONTAINER]);
}

maybeDescribe("file storage — MinIO container ship gate (real serve, presigned direct path)", () => {
  afterAll(() => stopMinio());

  it(
    "presigned PUT → confirm → getUrl 302 → reactive save; orphan reap; delete blob reclaim",
    async () => {
      const { endpoint } = await startMinio();
      const convexDir = makeFixtureConvexDir();
      const dataPath = join(mkdtempSync(join(tmpdir(), "sb-storage-s3-db-")), "db.sqlite");

      // The test-side view of the same bucket (the shipped adapter) — used to assert bucket-object
      // presence/absence directly, independent of the server.
      const bucketView = new S3BlobStore({
        bucket: BUCKET,
        region: "us-east-1",
        endpoint,
        accessKeyId: MINIO_USER,
        secretAccessKey: MINIO_PASS,
        forcePathStyle: true,
      });

      // The S3 client reads credentials + region from env (resolveStorageConfig); set them before
      // boot and restore after.
      const prevEnv = { ...process.env };
      process.env.AWS_ACCESS_KEY_ID = MINIO_USER;
      process.env.AWS_SECRET_ACCESS_KEY = MINIO_PASS;
      process.env.STACKBASE_STORAGE_REGION = "us-east-1";

      // Short TTL + sweep so an orphaned pending upload actually reaps within the test.
      const started = await startServe({
        convexDir,
        dataPath,
        ip: "127.0.0.1",
        port: 0,
        adminKey: "s3-key",
        dashboard: false,
        allowDeploy: false,
        storageBucket: BUCKET,
        storageEndpoint: endpoint,
        storageUploadTtlMs: 600,
        storageReaperSweepMs: 200,
      });
      const { server, store } = started;

      try {
        const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

        /* 1. generateUploadUrl → a PRESIGNED target pointing straight at the bucket. */
        const { value: up } = await run<CreateUploadResult>(server.url, "files:createUpload", {
          contentType: "image/png",
          visibility: "private",
        });
        expect(up.target.kind).toBe("presigned");
        expect(up.target.url).toContain(endpoint);
        const storageId = up.storageId;

        /* 2. PUT bytes DIRECTLY to the bucket — never through our server. */
        const putRes = await fetch(up.target.url, {
          method: up.target.method,
          headers: up.target.headers ?? {},
          body: BINARY,
        });
        expect(putRes.status).toBe(200);
        // The object physically exists in the bucket now.
        expect(await bucketView.read(storageId)).not.toBeNull();

        /* 3. confirm → row flips ready. The confirm url+token is surfaced on the target. */
        expect(up.target.confirmUrl).toBeTruthy();
        const confirmRes = await fetch(abs(server.url, up.target.confirmUrl!), { method: "POST" });
        expect(confirmRes.status).toBe(200);
        expect((await confirmRes.json()) as { storageId: string }).toEqual({ storageId });

        /* 4. getUrl → GET our serve endpoint → 302 to the signed bucket GET → original bytes. */
        const { value: getUrl } = await run<{ value: string }>(server.url, "files:getUrl", { id: storageId });
        expect(getUrl).not.toBeNull();
        const getRes = await fetch(abs(server.url, getUrl)); // fetch follows the 302 by default
        expect(getRes.status).toBe(200);
        const served = new Uint8Array(await getRes.arrayBuffer());
        expect(Array.from(served)).toEqual(Array.from(BINARY));

        /* 5. Store the Id<"_storage"> in a user row → a pre-opened files:list subscription updates. */
        const { ws, messages } = await subscribeToFiles(wsUrl);
        expect(latestMod(messages, 1)!.value).toEqual([]);
        await run(server.url, "files:save", { name: "s3.png", storageId });
        await waitFor(() => {
          const m = latestMod(messages, 1);
          return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length > 0;
        });
        expect(latestMod(messages, 1)!.value).toEqual([{ name: "s3.png", image: storageId }]);
        ws.close();

        /* 6. Orphan reap: a presigned upload PUT to the bucket but NEVER confirmed. After the TTL
         * expires and a reaper tick fires, the pending row AND its bucket object are gone. */
        const { value: orphan } = await run<CreateUploadResult>(server.url, "files:createUpload", {
          contentType: "application/octet-stream",
          visibility: "private",
        });
        await fetch(orphan.target.url, { method: orphan.target.method, headers: orphan.target.headers ?? {}, body: BINARY });
        expect(await bucketView.read(orphan.storageId)).not.toBeNull();
        // Wait past the TTL and let the reaper sweep.
        await waitForAsync(async () => {
          const { value } = await run<{ value: unknown }>(server.url, "files:getMeta", { id: orphan.storageId });
          return value === null;
        }, 20_000);
        const orphanMeta = await run<{ value: unknown }>(server.url, "files:getMeta", { id: orphan.storageId });
        expect(orphanMeta.value).toBeNull();
        expect(await bucketView.read(orphan.storageId)).toBeNull();

        /* 7. delete a CONFIRMED file → metadata gone; after a reaper tick the bucket object is gone. */
        await run(server.url, "files:remove", { id: storageId });
        const metaAfter = await run<{ value: unknown }>(server.url, "files:getMeta", { id: storageId });
        expect(metaAfter.value).toBeNull();
        await waitForAsync(async () => (await bucketView.read(storageId)) === null, 20_000);
        expect(await bucketView.read(storageId)).toBeNull();
      } finally {
        process.env = prevEnv;
        await server.close();
        store.close();
        stopMinio();
      }
    },
    { timeout: 180_000 },
  );
});

/** Async-predicate poll (the sync `waitFor` can't await the predicate). */
async function waitForAsync(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitForAsync timed out");
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}
