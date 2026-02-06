/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 2.3 — bootstrap / faithful-materialization E2E (design record §7): prove a SECOND process
 * re-materializes the IDENTICAL state from object storage alone, purely by replaying the segment
 * log (`ObjectStoreDocStore.open`'s bootstrap path) — no coordination with the first process, no
 * shared local state.
 *
 * `materializationScenario` runs a full MVCC series (insert, update via a new `prev_ts`, delete via
 * a tombstone, interleaved index writes) through one `ObjectStoreDocStore`, records its observable
 * state, then opens a SECOND `ObjectStoreDocStore` over the SAME bucket with a fresh local store and
 * asserts byte-for-byte parity — plus the segment seqno chain is dense (no gaps a bootstrap could
 * silently skip over).
 *
 * Runs against `objectstore-fs` (always-on, no docker) AND, gated, against a real `minio/minio`
 * container — mirrors `packages/objectstore-s3/test/s3.conformance.test.ts`'s lifecycle. The default
 * `bun run --filter @stackbase/objectstore-substrate test` must stay green with the MinIO variant
 * skipped (no docker/env required).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { ObjectStore } from "@stackbase/objectstore";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { S3ObjectStore } from "@stackbase/objectstore-s3";
import { ObjectStoreDocStore } from "../src/object-doc-store";

const TABLE = 30001;
const SHARD = "0";
const INDEX_ID = "by_body";

function doc(id: InternalDocumentId, body: string, prevTs: bigint | null = null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: { id, value: { body } } };
}

function tombstone(id: InternalDocumentId, prevTs: bigint): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: null };
}

function indexKey(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function indexPut(key: string, docId: InternalDocumentId): IndexWrite {
  return { ts: 0n, update: { indexId: INDEX_ID, key: indexKey(key), value: { type: "NonClustered", docId } } };
}

function indexDelete(key: string): IndexWrite {
  return { ts: 0n, update: { indexId: INDEX_ID, key: indexKey(key), value: { type: "Deleted" } } };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

const dirs: string[] = [];
async function freshBucket(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-bootstrap-e2e-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Commits a SERIES of mutations (insert A/B/C + index writes, update B via a new `prev_ts`, delete C
 * via a tombstone) through one `ObjectStoreDocStore` over `makeBucket()`'s bucket, then opens a
 * SECOND, independent `ObjectStoreDocStore` (fresh local store) over the SAME bucket and asserts its
 * bootstrapped state is byte-for-byte identical — plus the manifest's segment seqno chain is dense.
 */
async function materializationScenario(makeBucket: () => Promise<ObjectStore>): Promise<void> {
  const bucket = await makeBucket();
  const store1 = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
  // Tier 3 Slice 4, Task 4.2: commits now require a held lease.
  const acquired = await store1.acquire({ writerId: "w", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
  if (!acquired.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${acquired.heldBy})`);

  const idA = newDocumentId(TABLE);
  const idB = newDocumentId(TABLE);
  const idC = newDocumentId(TABLE);

  // Commit 1 (ts=1): insert A, B, C + one index entry per doc.
  await store1.commitWrite(
    [doc(idA, "a-v1"), doc(idB, "b-v1"), doc(idC, "c-v1")],
    [indexPut("a-v1", idA), indexPut("b-v1", idB), indexPut("c-v1", idC)],
  );

  // Commit 2 (ts=2): UPDATE B — a new revision chained via `prev_ts` = B's current ts, plus the
  // index delta (old key deleted, new key inserted).
  const bBefore = await store1.get(idB);
  await store1.commitWrite([doc(idB, "b-v2", bBefore!.ts)], [indexDelete("b-v1"), indexPut("b-v2", idB)]);

  // Commit 3 (ts=3): DELETE C — a tombstone chained via `prev_ts` = C's current ts.
  const cBefore = await store1.get(idC);
  await store1.commitWrite([tombstone(idC, cBefore!.ts)], [indexDelete("c-v1")]);

  const tableId = encodeStorageTableId(TABLE);
  const expectedA = await store1.get(idA);
  const expectedB = await store1.get(idB);
  const expectedC = await store1.get(idC);
  const expectedScan = await store1.scan(tableId);
  const expectedCount = await store1.count(tableId);
  const expectedMaxTs = await store1.maxTimestamp();

  // Sanity on #1's own state before trusting it as the oracle for #2.
  expect(expectedA).not.toBeNull();
  expect(expectedB).not.toBeNull();
  expect(expectedB!.value.value.body).toBe("b-v2");
  expect(expectedC).toBeNull(); // tombstoned — gone, not merely absent from scan
  expect(expectedScan.map((d) => d.value.value.body).sort()).toEqual(["a-v1", "b-v2"]);
  expect(expectedCount).toBe(2);
  expect(expectedMaxTs).toBe(3n);

  await store1.close();

  // A SECOND, independent ObjectStoreDocStore over the SAME bucket, fresh local store: bootstrap
  // replays the segment log alone — no shared process state with #1.
  const store2 = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });

  expect(await store2.get(idA)).toEqual(expectedA);
  expect(await store2.get(idB)).toEqual(expectedB);
  expect(await store2.get(idC)).toBeNull(); // C stays tombstoned after replay
  expect(await store2.scan(tableId)).toEqual(expectedScan);
  expect(await store2.count(tableId)).toBe(expectedCount);
  expect(await store2.maxTimestamp()).toBe(expectedMaxTs);

  // The manifest's segment seqno chain is DENSE — [0..n], contiguous, no gap a bootstrap could skip.
  const manifestEntry = await bucket.get(`s${SHARD}/manifest`);
  expect(manifestEntry).not.toBeNull();
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry!.body)) as { segments: number[] };
  expect(manifest.segments).toEqual([0, 1, 2]);
  manifest.segments.forEach((seqno, i) => expect(seqno).toBe(i));

  await store2.close();
}

describe("bootstrap: a second process materializes identical state from object storage alone", () => {
  it("fs — faithful materialization over objectstore-fs", async () => {
    await materializationScenario(freshBucket);
  });
});

// ── Gated: real MinIO container (mirrors packages/objectstore-s3/test/s3.conformance.test.ts) ─────

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const RUN = dockerAvailable() && process.env.STACKBASE_OBJECTSTORE_S3 === "1";
const maybeDescribe = RUN ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-objectstore-substrate-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-objectstore-substrate-bootstrap";

function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function startMinio(): Promise<string> {
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
  return endpoint;
}

function stopMinio(): void {
  runDocker(["rm", "-f", MINIO_CONTAINER]);
}

let endpoint = "";

maybeDescribe("bootstrap over real MinIO", () => {
  beforeAll(async () => {
    endpoint = await startMinio();
  }, 60_000);

  afterAll(() => stopMinio());

  it("minio — faithful materialization over a real S3-compatible bucket", async () => {
    await materializationScenario(
      async () =>
        new S3ObjectStore({
          endpoint,
          region: "us-east-1",
          accessKeyId: MINIO_USER,
          secretAccessKey: MINIO_PASS,
          bucket: BUCKET,
          forcePathStyle: true,
        }),
    );
  }, 60_000);
});
