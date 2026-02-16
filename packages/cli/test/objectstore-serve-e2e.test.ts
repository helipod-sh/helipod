/**
 * Tier 3 Slice 6, Task 6.4 — the HEADLINE E2E: a real `stackbase serve --object-store <url>` boots
 * a working reactive node over an object store, through the REAL production entrypoint
 * (`startServe`, the same core `serveCommand` calls) — mirrors `serve-e2e.test.ts`'s /
 * `storage-e2e.test.ts`'s "test through the shipped entrypoint" pattern, fs (hermetic, always-on) +
 * MinIO (gated, real S3-compatible container).
 *
 * The shared `scenario()` proves the plan's exact 5-step story:
 *   1. Boot node A over the object store (fs `file://` / a real MinIO bucket). `/api/health` is up
 *      and `objectStoreRelease` is present (proof this IS the object-store writer path, not a
 *      silent SQLite fallback).
 *   2. Commit a mutation via `POST /api/run` -> read it back via a query.
 *   3. A `notes:list` WS subscription opened BEFORE a second mutation fires reactively — the commit
 *      fan-out works over the object-store store, same reactive path as SQLite/Postgres.
 *   4. Graceful shutdown (`server.close()` -> `await objectStoreRelease()` -> `store.close()`, the
 *      exact order `serveCommand`'s own SIGTERM/SIGINT handler uses) — Task 6.5: `objectStoreRelease()`
 *      now calls `store.relinquish()`, which best-effort CAS-clears the lease IN THE BUCKET (not just
 *      node A's in-process hold — see `object-doc-store.ts`'s `relinquish()` doc), so a second node's
 *      `acquire()` succeeds IMMEDIATELY instead of waiting out the full lease TTL.
 *   5. Boot node B (fresh local data dir, SAME bucket) -> adopts node A's `deploymentId` (asserted
 *      via `store.getGlobal`, the Slice-4 carried-note-I1 proof already exercised by
 *      `objectstore-boot.test.ts`, now one level up through the real server) -> acquires PROMPTLY
 *      (well under the lease TTL — the wall clock is asserted below, closing the Task 6.4 review's
 *      Important finding) -> serves -> SEES A's committed data, materialized fresh from the bucket
 *      alone.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { startServe } from "../src/serve";

/* -------------------------------------------------------------------------- */
/* Fixture: reuse the committed deploy-v2 fixture (notes.add/list, by_box     */
/* index) — same convention `objectstore-boot.test.ts` uses for this slice.  */
/* -------------------------------------------------------------------------- */

const CONVEX_DIR = "test/fixtures/deploy-v2/convex";

/* -------------------------------------------------------------------------- */
/* WS + HTTP helpers (mirrors serve-e2e.test.ts / storage-e2e.test.ts)        */
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

/** `POST /api/run` a function and return its raw JSON body. */
async function run<T = unknown>(baseUrl: string, path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  if (res.status !== 200) throw new Error(`run ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

type Note = { box: string; text: string };

/* -------------------------------------------------------------------------- */
/* Cleanup bookkeeping                                                        */
/* -------------------------------------------------------------------------- */

const tmpDirs: string[] = [];
function freshDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sb-objstore-serve-e2e-${label}-`));
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
  const adminKey = `objstore-e2e-${label}`;

  /* 1. Boot node A over the object store. */
  const nodeA = await startServe({
    convexDir: CONVEX_DIR,
    dataPath: freshDataDir(`${label}-a`),
    ip: "127.0.0.1",
    port: 0,
    adminKey,
    dashboard: false,
    allowDeploy: false,
    objectStoreUrl,
  });
  // This IS the object-store writer path (not a silent SQLite fallback): `objectStoreRelease` is
  // only ever returned when `objectStoreUrl` was honored — see `startServe`'s doc comment.
  expect(nodeA.objectStoreRelease).toBeDefined();

  let deploymentIdA: unknown;
  let nodeAClosed = false;
  try {
    const health = await fetch(`${nodeA.server.url}/api/health`);
    expect(health.status).toBe(200);

    /* 2. Commit a mutation via POST /api/run -> read it back via a query. */
    const added = await run<{ value: unknown }>(nodeA.server.url, "notes:add", { box: "b1", text: "hello" });
    expect(added.value).toBeTruthy();
    const afterAdd = await run<{ value: Note[] }>(nodeA.server.url, "notes:list", {});
    expect(afterAdd.value).toEqual([{ box: "b1", text: "hello" }]);

    /* 3. A WS subscription opened BEFORE a second mutation fires reactively. */
    const wsUrl = `ws://127.0.0.1:${nodeA.server.port}/api/sync`;
    const { ws, messages } = await subscribeToNotes(wsUrl);
    expect(latestMod(messages, 1)!.value).toEqual([{ box: "b1", text: "hello" }]);

    await run(nodeA.server.url, "notes:add", { box: "b2", text: "world" });
    await waitFor(() => {
      const m = latestMod(messages, 1);
      return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length === 2;
    });
    expect(latestMod(messages, 1)!.value).toEqual([
      { box: "b1", text: "hello" },
      { box: "b2", text: "world" },
    ]);
    ws.close();

    deploymentIdA = await nodeA.store.getGlobal("fleet:deploymentId");
    expect(typeof deploymentIdA).toBe("string");

    /* 4. Graceful shutdown — the exact order serveCommand's own SIGTERM/SIGINT handler uses:
     * server.close() (stops the heartbeat driver) BEFORE await objectStoreRelease() BEFORE
     * store.close(). Task 6.5: objectStoreRelease() now calls store.relinquish(), which
     * best-effort CAS-clears the lease in the bucket — awaited so node B's takeover below is
     * measuring a genuinely-cleared lease, not racing an in-flight CAS. */
    await nodeA.server.close();
    await nodeA.objectStoreRelease?.();
    await nodeA.store.close();
    nodeAClosed = true;
  } finally {
    if (!nodeAClosed) {
      await nodeA.server.close().catch(() => {});
      await nodeA.objectStoreRelease?.().catch(() => {});
      await Promise.resolve(nodeA.store.close()).catch(() => {});
    }
  }

  /* 5. Boot node B: FRESH local data dir, SAME bucket. Task 6.5: node A's relinquish() ALREADY
   * cleared the lease in the bucket (step 4, above) — node B's `acquire()` (via `acquireWithRetry`)
   * should therefore succeed on its very first poll, PROMPTLY, not after waiting out the real
   * default lease TTL (15s). Assert the wall clock directly: this is the exact behavior the Task 6.4
   * review flagged as missing (a full-TTL write outage on every graceful rolling deploy). */
  const takeoverStart = Date.now();
  const nodeB = await startServe({
    convexDir: CONVEX_DIR,
    dataPath: freshDataDir(`${label}-b`),
    ip: "127.0.0.1",
    port: 0,
    adminKey,
    dashboard: false,
    allowDeploy: false,
    objectStoreUrl,
  });
  const takeoverMs = Date.now() - takeoverStart;
  try {
    // THE assertion this fix exists for: node B's acquire (inside startServe -> bootLoaded ->
    // buildObjectStoreWriterNode -> acquireWithRetry) must NOT have waited out node A's lease TTL
    // (default 15000ms) — a prompt takeover completes in well under a second locally; an 8000ms
    // bound absorbs CI/MinIO-container network variance while still being unambiguously far below
    // the 15000ms TTL this fix eliminates waiting for.
    expect(takeoverMs).toBeLessThan(8000);

    // Adopts node A's deploymentId — never mints a fresh one (Slice-4 carried-note I1).
    const deploymentIdB = await nodeB.store.getGlobal("fleet:deploymentId");
    expect(deploymentIdB).toBe(deploymentIdA);

    // Sees node A's committed data, materialized fresh from the bucket (a brand-new local dir).
    const listedB = await run<{ value: Note[] }>(nodeB.server.url, "notes:list", {});
    expect(listedB.value).toEqual([
      { box: "b1", text: "hello" },
      { box: "b2", text: "world" },
    ]);
  } finally {
    await nodeB.server.close();
    await nodeB.objectStoreRelease?.();
    await nodeB.store.close();
  }
}

/* -------------------------------------------------------------------------- */
/* fs arm — hermetic, always on                                               */
/* -------------------------------------------------------------------------- */

describe("stackbase serve --object-store — end-to-end (fs, real server)", () => {
  it(
    "commit -> bucket -> reactive fan-out -> read-back; a second node takes over IMMEDIATELY after relinquish (Task 6.5)",
    async () => {
      const bucketDir = mkdtempSync(join(tmpdir(), "sb-objstore-serve-e2e-fs-bucket-"));
      tmpDirs.push(bucketDir);
      await scenario(`file://${bucketDir}`, "fs");
    },
    // No longer needs to be generous for a full-TTL wait (Task 6.5 fix) — kept moderately above the
    // fast-path expectation to absorb ordinary CI slack around boot/materialize/HTTP round trips.
    20_000,
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

const MINIO_CONTAINER = `sb-minio-objstore-serve-e2e-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-objstore-serve-e2e";

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

maybeDescribe("stackbase serve --object-store — end-to-end (real MinIO, gated)", () => {
  afterAll(() => stopMinio());

  it(
    "commit -> bucket -> reactive fan-out -> read-back; a second node takes over IMMEDIATELY after relinquish (Task 6.5)",
    async () => {
      const { port } = await startMinio();
      const objectStoreUrl = `s3://${MINIO_USER}:${MINIO_PASS}@127.0.0.1:${port}/${BUCKET}?region=us-east-1&forcePathStyle=true`;
      await scenario(objectStoreUrl, "minio");
    },
    // Docker/MinIO spin-up dominates this budget now (Task 6.5 removed the full-TTL wait); still
    // generous for container start + network round trips.
    90_000,
  );
});
