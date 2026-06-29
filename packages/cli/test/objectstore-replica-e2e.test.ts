/**
 * Tier 3 Slice 8, Task 8.3 — the HEADLINE E2E: a WRITER node + a REPLICA node over the SAME
 * object-store bucket, each a real `stackbase serve` boot through the shipped `startServe` entrypoint
 * (real HTTP + WebSocket servers, real `ObjectStoreDocStore`s, real bucket I/O — the same "two real
 * serve processes" pattern `objectstore-serve-e2e.test.ts` (Slice 6) already established for a
 * writer-vs-successor-writer takeover; this file is its read-scaled sibling), fs (hermetic, always
 * on) + real MinIO (gated).
 *
 * The shared `scenario()` proves the plan's exact 5-step story (see
 * `docs/superpowers/plans/2026-07-13-tier3-slice8-replica-serve.md`, "## Task 8.3"):
 *   1. Boot a WRITER (`--object-store <url>`) and a REPLICA (`--object-store <url> --replica`) over
 *      the SAME bucket — distinct local data dirs, distinct ports, same admin key. Both `/api/health`.
 *   2. The replica adopts the writer's `deploymentId` and materializes the writer's PRE-boot committed
 *      state (a query on the replica returns it) — `ObjectStoreDocStore.open()`'s bootstrap alone, no
 *      tailer round needed.
 *   3. A `notes:list` WS subscription opened on the REPLICA; a mutation committed on the WRITER via
 *      `POST /api/run`; the REPLICA's subscription FIRES with the writer's new data — cross-node
 *      reactive propagation through TWO real `stackbase serve` processes, over object storage alone
 *      (the replica's own reactive tailer, Task 8.1/8.2, driving it — no shared database).
 *   4. A mutation via `POST /api/run` on the REPLICA is REJECTED (non-2xx, the clear "read replica"
 *      message) — free from the lease requirement (the replica never `acquire()`d) — and the writer's
 *      data is unaffected.
 *   5. The replica published a consumer watermark: `readConsumerWatermarks` over the SAME bucket shows
 *      a `s0/consumers/<id>` entry with a non-negative `appliedSeqno` — the writer's gc-driver (Slice
 *      7) will respect it.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { startServe } from "../src/serve";
import { resolveObjectStore } from "../src/objectstore-select";
import { readConsumerWatermarks } from "@stackbase/objectstore-substrate";

/* -------------------------------------------------------------------------- */
/* Fixture: the same committed deploy-v2 fixture (notes.add/list) used by     */
/* Slice 6/7/8's other object-store CLI tests.                                */
/* -------------------------------------------------------------------------- */

const FUNCTIONS_DIR = "test/fixtures/deploy-v2/convex";

/* -------------------------------------------------------------------------- */
/* WS + HTTP helpers (mirrors objectstore-serve-e2e.test.ts / serve-e2e.test.ts) */
/* -------------------------------------------------------------------------- */

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

async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 25));
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

/** Subscribe to `notes:list` over WS and wait for the initial `QueryUpdated`. */
async function subscribeToNotes(wsUrl: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: {} }], remove: [] });
  await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
  return { ws, messages };
}

/** `POST /api/run` a function and return its raw JSON body. Throws on non-200. */
async function run<T = unknown>(baseUrl: string, path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  if (res.status !== 200) throw new Error(`run ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** `POST /api/run`, returning the raw status + body without throwing — for asserting a REJECTION. */
async function runRaw(baseUrl: string, path: string, args: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  return { status: res.status, body: await res.text() };
}

type Note = { box: string; text: string };

/* -------------------------------------------------------------------------- */
/* Cleanup bookkeeping                                                        */
/* -------------------------------------------------------------------------- */

const tmpDirs: string[] = [];
function freshDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sb-objstore-replica-e2e-${label}-`));
  tmpDirs.push(dir);
  return join(dir, "db.sqlite");
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* The shared scenario — the plan's exact 5 steps                             */
/* -------------------------------------------------------------------------- */

async function scenario(objectStoreUrl: string, label: string): Promise<void> {
  const adminKey = `objstore-replica-e2e-${label}`;

  /* 1. Boot the WRITER over the object store. */
  const writer = await startServe({
    functionsDir: FUNCTIONS_DIR,
    dataPath: freshDataDir(`${label}-writer`),
    ip: "127.0.0.1",
    port: 0,
    adminKey,
    dashboard: false,
    allowDeploy: false,
    objectStoreUrl,
  });
  expect(writer.objectStoreRelease).toBeDefined();

  let writerClosed = false;
  try {
    const writerHealth = await fetch(`${writer.server.url}/api/health`);
    expect(writerHealth.status).toBe(200);

    // Seed data BEFORE the replica ever boots — proves the replica's `ObjectStoreDocStore.open()`
    // bootstrap (not just its tailer) materializes pre-existing bucket state.
    await run(writer.server.url, "notes:add", { box: "b1", text: "seed" });
    const seededOnWriter = await run<{ value: Note[] }>(writer.server.url, "notes:list", {});
    expect(seededOnWriter.value).toEqual([{ box: "b1", text: "seed" }]);

    /* 1 (cont.). Boot the REPLICA over the SAME bucket — a distinct local data dir + port. */
    const replica = await startServe({
      functionsDir: FUNCTIONS_DIR,
      dataPath: freshDataDir(`${label}-replica`),
      ip: "127.0.0.1",
      port: 0,
      adminKey,
      dashboard: false,
      allowDeploy: false,
      objectStoreUrl,
      replica: true,
    });
    // This IS the replica boot path (not a silent writer fallback).
    expect(replica.objectStoreRelease).toBeDefined();

    let replicaClosed = false;
    try {
      const replicaHealth = await fetch(`${replica.server.url}/api/health`);
      expect(replicaHealth.status).toBe(200);

      /* 2. The replica adopts the writer's deploymentId + materializes its pre-boot state. */
      const deploymentIdWriter = await writer.store.getGlobal("fleet:deploymentId");
      const deploymentIdReplica = await replica.store.getGlobal("fleet:deploymentId");
      expect(typeof deploymentIdWriter).toBe("string");
      expect(deploymentIdReplica).toBe(deploymentIdWriter);

      const bootstrapped = await run<{ value: Note[] }>(replica.server.url, "notes:list", {});
      expect(bootstrapped.value).toEqual([{ box: "b1", text: "seed" }]);

      /* 3. A WS subscription on the REPLICA; a mutation on the WRITER; the REPLICA's subscription
       * FIRES with the writer's new data — cross-node reactive propagation over object storage alone.
       * The replica's reactive tailer polls at its default 1000ms cadence (no test-only speedup
       * threaded through `startServe`'s ServeOptions) — allow a generous timeout for a real tick. */
      const wsUrl = `ws://127.0.0.1:${replica.server.port}/api/sync`;
      const { ws, messages } = await subscribeToNotes(wsUrl);
      expect(latestMod(messages, 1)!.value).toEqual([{ box: "b1", text: "seed" }]);

      await run(writer.server.url, "notes:add", { box: "b2", text: "from-writer" });
      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length === 2;
      }, 20_000);
      expect(latestMod(messages, 1)!.value).toEqual([
        { box: "b1", text: "seed" },
        { box: "b2", text: "from-writer" },
      ]);
      ws.close();

      /* 4. A mutation on the REPLICA is REJECTED; the writer's data is unaffected. */
      const rejected = await runRaw(replica.server.url, "notes:add", { box: "b1", text: "should-not-land" });
      expect(rejected.status).not.toBe(200);
      expect(rejected.body).toMatch(/read replica/i);

      const writerAfter = await run<{ value: Note[] }>(writer.server.url, "notes:list", {});
      expect(writerAfter.value).toEqual([
        { box: "b1", text: "seed" },
        { box: "b2", text: "from-writer" },
      ]);
      // The rejected mutation didn't land on the replica's own materialization either.
      const replicaAfterReject = await run<{ value: Note[] }>(replica.server.url, "notes:list", {});
      expect(replicaAfterReject.value.length).toBe(2);

      /* 5. The replica published a consumer watermark — the writer's gc respects it. */
      const resolved = resolveObjectStore(objectStoreUrl);
      expect(resolved).not.toBeNull();
      const watermarks = await readConsumerWatermarks(resolved!.objectStore, "0");
      expect(watermarks.length).toBeGreaterThan(0);
      for (const w of watermarks) expect(w.appliedSeqno).toBeGreaterThanOrEqual(0);

      /* Graceful shutdown — replica first (mirrors the writer's own SIGTERM/SIGINT ordering:
       * server.close() stops drivers/the tailer BEFORE objectStoreRelease() BEFORE store.close()). */
      await replica.server.close();
      await replica.objectStoreRelease?.();
      await replica.store.close();
      replicaClosed = true;
    } finally {
      if (!replicaClosed) {
        await replica.server.close().catch(() => {});
        await replica.objectStoreRelease?.().catch(() => {});
        await Promise.resolve(replica.store.close()).catch(() => {});
      }
    }

    await writer.server.close();
    await writer.objectStoreRelease?.();
    await writer.store.close();
    writerClosed = true;
  } finally {
    if (!writerClosed) {
      await writer.server.close().catch(() => {});
      await writer.objectStoreRelease?.().catch(() => {});
      await Promise.resolve(writer.store.close()).catch(() => {});
    }
  }
}

/* -------------------------------------------------------------------------- */
/* fs arm — hermetic, always on                                               */
/* -------------------------------------------------------------------------- */

describe("stackbase serve --object-store --replica — end-to-end (fs, real server)", () => {
  it(
    "writer + replica over one bucket: cross-node reactive fan-out, replica rejects writes, replica publishes its watermark",
    async () => {
      const bucketDir = mkdtempSync(join(tmpdir(), "sb-objstore-replica-e2e-fs-bucket-"));
      tmpDirs.push(bucketDir);
      await scenario(`file://${bucketDir}`, "fs");
    },
    30_000,
  );
});

/* -------------------------------------------------------------------------- */
/* MinIO arm — gated, real S3-compatible container                           */
/* -------------------------------------------------------------------------- */

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const RUN_MINIO = dockerAvailable() && process.env.STACKBASE_OBJECTSTORE_S3 === "1";
const maybeDescribe = RUN_MINIO ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-objstore-replica-e2e-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-objstore-replica-e2e";

function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Resolve `@aws-sdk/client-s3` from `@stackbase/objectstore-s3`'s own node_modules (used only for
 * bucket creation — the scenario itself goes entirely through the shipped `--object-store` URL /
 * `resolveObjectStore` path, never constructing an `S3ObjectStore` directly). */
function loadS3Sdk(): { S3Client: any; CreateBucketCommand: any } {
  const reqRoot = createRequire(import.meta.url);
  const reqS3 = createRequire(reqRoot.resolve("@stackbase/objectstore-s3"));
  return reqS3("@aws-sdk/client-s3");
}

async function startMinio(): Promise<{ endpoint: string; port: string }> {
  runDocker(["rm", "-f", MINIO_CONTAINER]);
  const started = runDocker([
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
  if (started.status !== 0) throw new Error(`docker run minio failed: ${started.stderr}`);

  const portRes = runDocker(["port", MINIO_CONTAINER, "9000/tcp"]);
  const line = portRes.stdout.trim().split("\n")[0] ?? "";
  const m = line.match(/:(\d+)$/);
  if (!m) throw new Error(`could not parse minio \`docker port\`: ${JSON.stringify(portRes.stdout)}`);
  const port = m[1]!;
  const endpoint = `http://127.0.0.1:${port}`;

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
  return { endpoint, port };
}

function stopMinio(): void {
  runDocker(["rm", "-f", MINIO_CONTAINER]);
}

maybeDescribe("stackbase serve --object-store --replica — end-to-end (real MinIO, gated)", () => {
  afterAll(() => stopMinio());

  it(
    "writer + replica over one bucket: cross-node reactive fan-out, replica rejects writes, replica publishes its watermark",
    async () => {
      const { port } = await startMinio();
      const objectStoreUrl = `s3://${MINIO_USER}:${MINIO_PASS}@127.0.0.1:${port}/${BUCKET}?region=us-east-1&forcePathStyle=true`;
      await scenario(objectStoreUrl, "minio");
    },
    // Docker/MinIO spin-up + the replica's poll-driven tailer dominate this budget.
    100_000,
  );
});
