/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 3.4 — the Slice-3 HEADLINE E2E (design record §7, Tier 3 whole-arc plan): over a LONG commit
 * history, snapshot cadence (Task 3.2) + `gc()` (Task 3.3) keep the durable object set BOUNDED — and
 * a fresh process bootstrapping from the GC'd bucket alone still materializes the EXACT current
 * state. Bootstrap no longer scales with history; it scales with `SNAPSHOT_EVERY` + the post-snapshot
 * tail.
 *
 * `scenario` drives > 2*SNAPSHOT_EVERY commits (inserts, updates-of-earlier-docs via a new `prev_ts`,
 * and deletes via tombstones) through one `ObjectStoreDocStore`, tracking the expected FINAL live
 * state as it goes. It triggers two cadence snapshots (each superseding the last), calls `gc()`, then
 * asserts (1) only a bounded tail of segment objects plus exactly one snapshot object survives, and
 * (2) a SECOND, fresh `ObjectStoreDocStore` over the SAME GC'd bucket reconstructs byte-identical
 * state — proving it never needed the (now physically absent) pre-snapshot segments.
 *
 * Runs against `objectstore-fs` (always-on, no docker) AND, gated, against a real `minio/minio`
 * container — same harness shape as `bootstrap.e2e.test.ts`. The default
 * `bun run --filter @stackbase/objectstore-substrate test` must stay green with the MinIO variant
 * skipped (no docker/env required).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newDocumentId, documentIdKey, encodeStorageTableId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { ObjectStore } from "@stackbase/objectstore";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { S3ObjectStore } from "@stackbase/objectstore-s3";
import { ObjectStoreDocStore } from "../src/object-doc-store";

const TABLE = 30001;
const SHARD = "0";

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here (not exported; see the same note in
// snapshot-cadence.test.ts / gc.test.ts) so the commit loops below are sized to actually trigger
// two cadence snapshots plus a bounded tail.
const SNAPSHOT_EVERY = 8;

function doc(id: InternalDocumentId, body: string, prevTs: bigint | null = null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: { id, value: { body } } };
}

function tombstone(id: InternalDocumentId, prevTs: bigint): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: null };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

const dirs: string[] = [];
async function freshBucket(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-snapshot-gc-e2e-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function readManifestRaw(bucket: ObjectStore): Promise<{ segments: number[]; snapshotTs?: string; snapshotSegBase?: number }> {
  const e = await bucket.get(`s${SHARD}/manifest`);
  return JSON.parse(new TextDecoder().decode(e!.body));
}

/**
 * Drives > 2*SNAPSHOT_EVERY commits — 8 inserts (triggers snapshot #1), then 8 more commits mixing
 * updates/deletes/inserts (triggers snapshot #2, superseding #1), then a small tail (not enough to
 * trigger a 3rd) — through one `ObjectStoreDocStore` over `makeBucket()`'s bucket, tracking the
 * expected FINAL live state throughout. Then `gc()`s and asserts the durable object set is bounded,
 * and that a SECOND, fresh `ObjectStoreDocStore` over the same (now GC'd) bucket materializes the
 * exact same state.
 */
async function scenario(makeBucket: () => Promise<ObjectStore>): Promise<void> {
  const bucket = await makeBucket();
  const store = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
  // Tier 3 Slice 4, Task 4.2: commits now require a held lease.
  const acquired = await store.acquire({ writerId: "w", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
  if (!acquired.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${acquired.heldBy})`);

  // Expected FINAL current state, tracked as we go: live id -> body (a delete removes the entry).
  const expected = new Map<string, { id: InternalDocumentId; body: string }>();
  const lastTs = new Map<string, bigint>();
  let totalCommits = 0;

  async function insertDoc(body: string): Promise<InternalDocumentId> {
    const id = newDocumentId(TABLE);
    const key = documentIdKey(id);
    const ts = await store.commitWrite([doc(id, body)], []);
    expected.set(key, { id, body });
    lastTs.set(key, ts);
    totalCommits++;
    return id;
  }
  async function updateDoc(id: InternalDocumentId, body: string): Promise<void> {
    const key = documentIdKey(id);
    const prevTs = lastTs.get(key)!;
    const ts = await store.commitWrite([doc(id, body, prevTs)], []);
    expected.set(key, { id, body });
    lastTs.set(key, ts);
    totalCommits++;
  }
  async function deleteDoc(id: InternalDocumentId): Promise<void> {
    const key = documentIdKey(id);
    const prevTs = lastTs.get(key)!;
    await store.commitWrite([tombstone(id, prevTs)], []);
    expected.delete(key);
    lastTs.delete(key);
    totalCommits++;
  }

  // Phase 1 (commits 1-8): 8 inserts — triggers cadence snapshot #1 (SNAPSHOT_EVERY = 8).
  const a: InternalDocumentId[] = [];
  for (let i = 0; i < SNAPSHOT_EVERY; i++) {
    a.push(await insertDoc(`a${i}-v1`));
  }

  // Phase 2 (commits 9-16): a MIX of updates-of-earlier-docs, deletes, and a couple more inserts —
  // 8 more commits, triggering cadence snapshot #2 (superseding #1).
  await updateDoc(a[0]!, "a0-v2");
  await updateDoc(a[1]!, "a1-v2");
  await deleteDoc(a[2]!);
  const b0 = await insertDoc("b0-v1");
  await updateDoc(a[3]!, "a3-v2");
  await deleteDoc(a[4]!);
  const b1 = await insertDoc("b1-v1");
  await updateDoc(a[5]!, "a5-v2");

  // Phase 3 (commits 17-19): a small tail beyond snapshot #2 — NOT enough (< SNAPSHOT_EVERY) to
  // trigger a 3rd snapshot, so gc() below must reclaim segments 0..15 but keep this tail.
  const b2 = await insertDoc("b2-v1");
  await updateDoc(a[6]!, "a6-v2");
  await deleteDoc(b0);

  expect(totalCommits).toBe(19);
  expect(totalCommits).toBeGreaterThan(2 * SNAPSHOT_EVERY);

  // Final live set: a0,a1,a3,a5,a6 (updated), a7 (untouched since insert), b1, b2 (untouched). Dead:
  // a2, a4 (deleted), b0 (inserted then deleted in the tail). Sanity on the tracked oracle itself.
  expect(expected.size).toBe(8);
  expect([...expected.values()].map((v) => v.body).sort()).toEqual(
    ["a0-v2", "a1-v2", "a3-v2", "a5-v2", "a6-v2", "a7-v1", "b1-v1", "b2-v1"].sort(),
  );
  expect(await store.get(b1)).not.toBeNull();
  expect(await store.get(b2)).not.toBeNull();

  const tableId = encodeStorageTableId(TABLE);
  const expectedCount = await store.count(tableId);
  const expectedScan = await store.scan(tableId);
  const expectedMaxTs = await store.maxTimestamp();
  expect(expectedCount).toBe(expected.size);
  expect(expectedScan.length).toBe(expected.size);

  // Sanity: tombstoned ids are truly GONE (not merely absent from scan).
  expect(await store.get(a[2]!)).toBeNull();
  expect(await store.get(a[4]!)).toBeNull();
  expect(await store.get(b0)).toBeNull();

  // ── gc() ─────────────────────────────────────────────────────────────────────────────────────
  const manifestPreGc = await readManifestRaw(bucket);
  expect(manifestPreGc.snapshotTs).toBeDefined();
  const segBase = manifestPreGc.snapshotSegBase!;
  expect(segBase).toBe(2 * SNAPSHOT_EVERY - 1); // last segment covered by snapshot #2

  const gcResult = await store.gc();
  expect(gcResult.deletedSegments).toBe(segBase + 1); // seqno 0..segBase, inclusive
  expect(gcResult.deletedSnapshots).toBe(1); // the superseded snapshot #1

  // Bounded-object assertion: only the tail SINCE the last snapshot survives — far fewer objects
  // than the total commit history, and never more than SNAPSHOT_EVERY.
  const segPrefix = `s${SHARD}/seg/`;
  const survivingSegKeys = await bucket.list(segPrefix);
  for (const key of survivingSegKeys) {
    const seqno = Number(key.slice(segPrefix.length));
    expect(seqno).toBeGreaterThan(segBase); // never a pre-snapshot segment
  }
  expect(survivingSegKeys.length).toBe(3); // the phase-3 tail (b2 insert, a6 update, b0 delete)
  expect(survivingSegKeys.length).toBeLessThanOrEqual(SNAPSHOT_EVERY);
  expect(survivingSegKeys.length).toBeLessThan(totalCommits);

  const snapPrefix = `s${SHARD}/snap/`;
  const survivingSnapKeys = await bucket.list(snapPrefix);
  expect(survivingSnapKeys.length).toBe(1);

  // Strengthener: every pre-snapshot segment is now PHYSICALLY ABSENT from the bucket.
  for (let seqno = 0; seqno <= segBase; seqno++) {
    expect(await bucket.get(`${segPrefix}${seqno}`)).toBeNull();
  }

  // ── Exact-state bootstrap assertion ─────────────────────────────────────────────────────────
  // A SECOND, fresh ObjectStoreDocStore over the SAME (now GC'd) bucket must materialize the EXACT
  // current state, reading ONLY the surviving snapshot + tail — the pre-snapshot segments the
  // strengthener above just proved are gone.
  const fresh = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });

  for (const { id, body } of expected.values()) {
    const restored = await fresh.get(id);
    expect(restored).not.toBeNull();
    expect(restored!.value.value.body).toBe(body);
  }
  for (const deadId of [a[2]!, a[4]!, b0]) {
    expect(await fresh.get(deadId)).toBeNull();
  }
  expect(await fresh.count(tableId)).toBe(expectedCount);
  const freshScan = await fresh.scan(tableId);
  expect(freshScan.map((d) => d.value.value.body).sort()).toEqual(expectedScan.map((d) => d.value.value.body).sort());
  expect(await fresh.maxTimestamp()).toBe(expectedMaxTs);

  await store.close();
  await fresh.close();
}

describe("ObjectStoreDocStore: snapshot cadence + gc keep the durable object set bounded over a long run", () => {
  it("fs — bounded objects post-gc + a fresh open materializes the exact current state", async () => {
    await scenario(freshBucket);
  });
});

// ── Gated: real MinIO container (mirrors bootstrap.e2e.test.ts / packages/objectstore-s3/test/s3.conformance.test.ts) ─────

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const RUN = dockerAvailable() && process.env.STACKBASE_OBJECTSTORE_S3 === "1";
const maybeDescribe = RUN ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-objectstore-substrate-snapgc-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-objectstore-substrate-snapshot-gc";

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

maybeDescribe("snapshot cadence + gc over a real MinIO bucket", () => {
  beforeAll(async () => {
    endpoint = await startMinio();
  }, 60_000);

  afterAll(() => stopMinio());

  it(
    "minio — bounded objects post-gc + a fresh open materializes the exact current state",
    async () => {
      await scenario(
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
    },
    60_000,
  );
});
