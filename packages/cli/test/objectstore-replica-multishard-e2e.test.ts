/**
 * Multi-shard replicas Task 2 — the HEADLINE multi-shard E2E: a 3-SHARD WRITER + a 3-SHARD REPLICA
 * over ONE object-store bucket, each a real `stackbase serve` boot through `startServe` (real HTTP +
 * WebSocket, real per-lane `ObjectStoreDocStore`s behind the `ShardedObjectStoreDocStore` composite,
 * real bucket I/O). The read-scaled sibling of `objectstore-serve-e2e.test.ts` (multi-shard writer
 * takeover) and `objectstore-replica-e2e.test.ts` (single-shard replica), fs (always) + real MinIO
 * (gated). Uses the channelId-sharded `shard-dev` fixture so lanes are genuinely exercised.
 *
 * The shared `scenario()` proves, over three physical lanes (default/s1/s2):
 *   1. A 3-shard WRITER (`--object-store <url> --shards 3`) + a REPLICA (`--object-store <url>
 *      --replica`, deriving 3 lanes from the bucket globals — no `--shards`) both `/api/health`.
 *   2. The replica adopts the writer's `deploymentId` and materializes the writer's PRE-boot committed
 *      messages across ALL three lanes (read each channel back).
 *   3. A WS subscription on the REPLICA to a channel whose lane is `s1` (a NON-default lane); a
 *      `messages:send` to that channel on the WRITER; the REPLICA's subscription FIRES — proving a
 *      non-default lane's own tailer drives cross-node reactivity over object storage alone.
 *   4. A `messages:send` on the REPLICA is REJECTED (the read-replica message); the writer is unaffected.
 *   5. EACH lane published its own consumer watermark (`s{default,s1,s2}/consumers/<id>:<shard>`), and
 *      after the replica's graceful shutdown EVERY lane's watermark was removed.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { shardIdForKeyValue } from "@stackbase/id-codec";
import { startServe } from "../src/serve";
import { resolveObjectStore } from "../src/objectstore-select";
import { readConsumerWatermarks } from "@stackbase/objectstore-substrate";

const CONVEX_DIR = "test/fixtures/shard-dev/convex";

/* ── WS + HTTP helpers (mirror objectstore-replica-e2e.test.ts) ───────────────────────────────── */

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

/** Subscribe to `messages:list` for one channel over WS and wait for the initial `QueryUpdated`. */
async function subscribeToChannel(wsUrl: string, channelId: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { channelId } }], remove: [] });
  await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
  return { ws, messages };
}

async function run<T = unknown>(baseUrl: string, path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  if (res.status !== 200) throw new Error(`run ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function runRaw(baseUrl: string, path: string, args: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  return { status: res.status, body: await res.text() };
}

type Msg = { channelId: string; body: string };

const tmpDirs: string[] = [];
function freshDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sb-objstore-replica-ms-e2e-${label}-`));
  tmpDirs.push(dir);
  return join(dir, "db.sqlite");
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* ── The shared scenario over three lanes ─────────────────────────────────────────────────────── */

// Three channels routing to three DISTINCT lanes at M=3 (asserted, not assumed): b3→default, b4→s1,
// b1→s2. `b4` (lane s1, a NON-default lane) carries the cross-node reactivity assertion.
const CHANNELS = ["b3", "b4", "b1"] as const;
const REACT_CHANNEL = "b4"; // lane s1

async function scenario(objectStoreUrl: string, label: string): Promise<void> {
  const adminKey = `objstore-replica-ms-e2e-${label}`;
  expect(new Set(CHANNELS.map((c) => shardIdForKeyValue(c, 3))).size).toBe(3);
  expect(shardIdForKeyValue(REACT_CHANNEL, 3)).toBe("s1"); // the reactivity channel is a non-default lane

  const writer = await startServe({
    functionsDir: CONVEX_DIR,
    dataPath: freshDataDir(`${label}-writer`),
    ip: "127.0.0.1",
    port: 0,
    adminKey,
    dashboard: false,
    allowDeploy: false,
    objectStoreUrl,
    objectStoreShards: 3,
  });
  expect(writer.objectStoreRelease).toBeDefined();

  let writerClosed = false;
  try {
    expect((await fetch(`${writer.server.url}/api/health`)).status).toBe(200);

    // Seed ONE message per channel BEFORE the replica boots (proves per-lane bootstrap materialization).
    for (const ch of CHANNELS) await run(writer.server.url, "messages:send", { channelId: ch, body: `seed-${ch}` });

    const replica = await startServe({
      functionsDir: CONVEX_DIR,
      dataPath: freshDataDir(`${label}-replica`),
      ip: "127.0.0.1",
      port: 0,
      adminKey,
      dashboard: false,
      allowDeploy: false,
      objectStoreUrl,
      replica: true,
    });
    expect(replica.objectStoreRelease).toBeDefined();

    let replicaClosed = false;
    try {
      expect((await fetch(`${replica.server.url}/api/health`)).status).toBe(200);

      /* 2. Adopts the deploymentId + materializes every lane's pre-boot message. */
      const deploymentIdWriter = await writer.store.getGlobal("fleet:deploymentId");
      expect(typeof deploymentIdWriter).toBe("string");
      expect(await replica.store.getGlobal("fleet:deploymentId")).toBe(deploymentIdWriter);
      for (const ch of CHANNELS) {
        const listed = await run<{ value: Msg[] }>(replica.server.url, "messages:list", { channelId: ch });
        expect(listed.value.map((m) => m.body), `bootstrap channel '${ch}'`).toEqual([`seed-${ch}`]);
      }

      /* 3. WS sub on the REPLICA for a NON-default lane's channel; commit on the WRITER; sub fires. */
      const wsUrl = `ws://127.0.0.1:${replica.server.port}/api/sync`;
      const { ws, messages } = await subscribeToChannel(wsUrl, REACT_CHANNEL);
      expect((latestMod(messages, 1)!.value as Msg[]).map((m) => m.body)).toEqual([`seed-${REACT_CHANNEL}`]);

      await run(writer.server.url, "messages:send", { channelId: REACT_CHANNEL, body: "from-writer" });
      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length === 2;
      }, 20_000);
      // Cross-node delivery is what this asserts (both rows present) — the intra-channel ordering
      // (index _creationTime/_id tiebreak) is covered elsewhere and not this test's concern.
      expect((latestMod(messages, 1)!.value as Msg[]).map((m) => m.body).sort()).toEqual(
        [`seed-${REACT_CHANNEL}`, "from-writer"].sort(),
      );
      ws.close();

      /* 4. A mutation on the REPLICA is REJECTED; the writer is unaffected. */
      const rejected = await runRaw(replica.server.url, "messages:send", { channelId: "b3", body: "should-not-land" });
      expect(rejected.status).not.toBe(200);
      expect(rejected.body).toMatch(/read replica/i);
      const writerB3 = await run<{ value: Msg[] }>(writer.server.url, "messages:list", { channelId: "b3" });
      expect(writerB3.value.map((m) => m.body)).toEqual(["seed-b3"]);

      /* 5. EACH lane published its own consumer watermark. */
      const resolved = resolveObjectStore(objectStoreUrl);
      expect(resolved).not.toBeNull();
      for (const shardId of ["default", "s1", "s2"]) {
        const watermarks = await readConsumerWatermarks(resolved!.objectStore, shardId);
        expect(watermarks.length, `lane '${shardId}' watermark`).toBeGreaterThan(0);
        for (const w of watermarks) expect(w.appliedSeqno).toBeGreaterThanOrEqual(0);
      }

      /* Graceful shutdown — replica first; then assert EVERY lane's watermark was removed. */
      await replica.server.close();
      await replica.objectStoreRelease?.();
      await replica.store.close();
      replicaClosed = true;

      for (const shardId of ["default", "s1", "s2"]) {
        const after = await readConsumerWatermarks(resolved!.objectStore, shardId);
        expect(after.length, `lane '${shardId}' watermark after release`).toBe(0);
      }
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

/* ── fs arm — hermetic, always on ─────────────────────────────────────────────────────────────── */

describe("stackbase serve --object-store --shards 3 --replica — end-to-end (fs, real server)", () => {
  it(
    "3-shard writer + 3-shard replica over one bucket: per-lane bootstrap, non-default-lane reactive fan-out, write reject, per-lane watermarks + removal",
    async () => {
      const bucketDir = mkdtempSync(join(tmpdir(), "sb-objstore-replica-ms-e2e-fs-bucket-"));
      tmpDirs.push(bucketDir);
      await scenario(`file://${bucketDir}`, "fs");
    },
    40_000,
  );
});

/* ── MinIO arm — gated, real S3-compatible container ──────────────────────────────────────────── */

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const RUN_MINIO = dockerAvailable() && process.env.STACKBASE_OBJECTSTORE_S3 === "1";
const maybeDescribe = RUN_MINIO ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-objstore-replica-ms-e2e-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-objstore-replica-ms-e2e";

function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

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

maybeDescribe("stackbase serve --object-store --shards 3 --replica — end-to-end (real MinIO, gated)", () => {
  afterAll(() => stopMinio());

  it(
    "3-shard writer + 3-shard replica over one bucket: per-lane bootstrap, non-default-lane reactive fan-out, write reject, per-lane watermarks + removal",
    async () => {
      const { port } = await startMinio();
      const objectStoreUrl = `s3://${MINIO_USER}:${MINIO_PASS}@127.0.0.1:${port}/${BUCKET}?region=us-east-1&forcePathStyle=true`;
      await scenario(objectStoreUrl, "minio");
    },
    120_000,
  );
});
