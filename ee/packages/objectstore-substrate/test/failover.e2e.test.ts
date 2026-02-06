/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 4.4 — the HEADLINE E2E (design record §4/§7/§10, Tier 3 Slice 4): a crashed shard owner is
 * failed over after its lease expires; the new owner bootstraps the FULL state from object storage
 * (snapshot + tail, Slice 3's machinery), ADOPTS the deployment identity from `globals` rather than
 * re-minting it (carried note I1), and resumes committing; the zombie old owner is fenced on its next
 * commit/heartbeat and cannot corrupt the log (carried note I2 — this is the MinIO-gated fence/failover
 * coverage the whole-branch review flagged as still missing at the substrate level).
 *
 * The six-step scenario (plan's Task 4.4):
 *  1. `ensureGlobals` seeds `{deploymentId:"dep-1", numShards:1}`. Writer A `open`+`acquire`s shard "0"
 *     at now=0 (ttl=1000) and commits ENOUGH mutations (insert/update/delete mixed) to force at least
 *     one snapshot (>= SNAPSHOT_EVERY segments), then heartbeats a couple of times while its lease is
 *     still live (renewing it).
 *  2. A "crashes" — nothing further is ever called on `storeA` except the revival in step 5. `now`
 *     advances past A's LAST (heartbeat-renewed) `leaseExpiresAt`.
 *  3. Writer B: a FRESH local store + a FRESH `ensureGlobals` call with a DIFFERENT deploymentId
 *     ("dep-2") — asserted to ADOPT "dep-1", not mint "dep-2". B `open`s shard "0" (bootstraps
 *     snapshot+tail from the bucket) and `acquire`s past A's expiry → `{acquired:true}`, with the
 *     manifest's `epoch` bumped and `writerId === "B"`.
 *  4. B commits new mutations; B's local `scan` reflects BOTH A's full committed history AND B's new
 *     writes — the takeover bootstrapped the complete state, not just a tail slice.
 *  5. A "revives" (a zombie writer, unaware it was fenced): A's next `commit`/`heartbeat` throws
 *     `FencedError` and poisons A. The manifest still references B's frontier — A's zombie attempt did
 *     not corrupt the log (the keep-first `putImmutable` + manifest-CAS-on-stale-etag discipline
 *     `lease.test.ts`'s 4.2e already proves at the unit level; this asserts the OUTCOME here too).
 *  6. A truly-fresh third instance (`open`+`acquire`) materializes the FINAL combined state
 *     byte-identically — asserted doc-by-doc against an independently-tracked expected map (not by
 *     trusting B's own view, which could share a bug with the bootstrap it's being compared against).
 *
 * Runs against `objectstore-fs` (always-on, no docker) AND, gated, against a real `minio/minio`
 * container — mirrors `bootstrap.e2e.test.ts`'s and `snapshot-gc.e2e.test.ts`'s harness shape exactly.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, internalIdToHex, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { ObjectStore } from "@stackbase/objectstore";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { S3ObjectStore } from "@stackbase/objectstore-s3";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { ensureGlobals } from "../src/globals";
import { FencedError } from "../src/fenced-error";
import { readManifest } from "../src/manifest";

const TABLE = 30001;
const SHARD = "0";

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
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-failover-e2e-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** No native op to force a snapshot — `ObjectStoreDocStore`'s `SNAPSHOT_EVERY` is an internal
 *  constant, deliberately not exported (see its doc: "Small deliberately"). This mirrors that
 *  constant so the scenario reliably commits past at least one snapshot boundary without either
 *  package needing to expose it. If the constant ever changes, this test's commit count still just
 *  needs to be `>=` it — err generously high rather than re-deriving it exactly. */
const SNAPSHOT_EVERY = 8;

async function scenario(makeBucket: () => Promise<ObjectStore>): Promise<void> {
  const bucket = await makeBucket();

  // ── Step 1: globals + Writer A claims the shard and builds up committed history ──────────────
  const globalsA = await ensureGlobals(bucket, { deploymentId: "dep-1", numShards: 1 });
  expect(globalsA).toEqual({ deploymentId: "dep-1", numShards: 1 });

  const storeA = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
  const acquireA = await storeA.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 });
  expect(acquireA).toEqual({ acquired: true });

  // An independently-tracked oracle of "what SHOULD exist" — built up alongside the real commits so
  // step 6's final assertion never has to trust the very bootstrap machinery it's verifying. Keyed by
  // the actual `InternalDocumentId` object reference minted at insert time (reused verbatim for every
  // later lookup — no re-encode/decode round-trip needed, since we hold the originals throughout).
  const expected = new Map<InternalDocumentId, string | null>();

  // Insert enough rows across enough commits (mixing insert/update/delete) to force >= 1 snapshot
  // (SNAPSHOT_EVERY segments) — so B's later takeover bootstrap exercises snapshot+tail replay, not
  // just a short tail.
  const ids: InternalDocumentId[] = [];
  for (let i = 0; i < SNAPSHOT_EVERY + 3; i++) {
    const id = newDocumentId(TABLE);
    ids.push(id);
    await storeA.commitWrite([doc(id, `a-row-${i}-v1`)], []);
    expected.set(id, `a-row-${i}-v1`);
  }
  // A couple of heartbeats while the lease is still live (renewing it) — proves a heartbeating owner
  // doesn't spuriously expire mid-session.
  await storeA.heartbeat({ now: 100, leaseTtlMs: 1000 });
  await storeA.heartbeat({ now: 300, leaseTtlMs: 1000 });

  // Update one row and delete another, both AFTER the heartbeats, so the oracle also covers a
  // prev_ts-chained update and a tombstone — not just fresh inserts.
  const updatedId = ids[0]!;
  const updatedBefore = await storeA.get(updatedId);
  await storeA.commitWrite([doc(updatedId, "a-row-0-v2", updatedBefore!.ts)], []);
  expected.set(updatedId, "a-row-0-v2");

  const deletedId = ids[1]!;
  const deletedBefore = await storeA.get(deletedId);
  await storeA.commitWrite([tombstone(deletedId, deletedBefore!.ts)], []);
  expected.set(deletedId, null);

  const manifestAfterA = await readManifest(bucket, SHARD);
  expect(manifestAfterA).not.toBeNull();
  // With SNAPSHOT_EVERY+3 inserts + update + delete = SNAPSHOT_EVERY+5 commits, a snapshot must have
  // fired at least once (maybeSnapshot's best-effort trigger runs after every commitWriteBatch).
  expect(manifestAfterA!.manifest.snapshotTs).toBeDefined();

  // ── Step 2: A "crashes" (silently stop calling it) — now advances past A's LAST renewed lease ──
  // A's last heartbeat was at now=300 with ttl=1000 -> leaseExpiresAt=1300. Advance well past it.
  const now2000 = 2000;

  // ── Step 3: Writer B — fresh local store, fresh ensureGlobals with a DIFFERENT deploymentId ────
  const globalsB = await ensureGlobals(bucket, { deploymentId: "dep-2", numShards: 1 });
  // B must ADOPT "dep-1" — the carried-note-I1 proof. A re-minted deploymentId would flip every
  // outbox client to `known:false`.
  expect(globalsB).toEqual({ deploymentId: "dep-1", numShards: 1 });

  const storeB = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
  const acquireB = await storeB.acquire({ writerId: "B", leaseTtlMs: 1000, now: now2000 });
  expect(acquireB).toEqual({ acquired: true });

  const manifestAfterB = await readManifest(bucket, SHARD);
  expect(manifestAfterB).not.toBeNull();
  expect(manifestAfterB!.manifest.epoch).toBe(2); // A's acquire = epoch 1; B's fencing acquire = epoch 2
  expect(manifestAfterB!.manifest.writerId).toBe("B");

  // ── Step 4: B commits new mutations — its local scan reflects A's FULL history + B's new writes ──
  const newIds: InternalDocumentId[] = [];
  for (let i = 0; i < 3; i++) {
    const id = newDocumentId(TABLE);
    newIds.push(id);
    await storeB.commitWrite([doc(id, `b-row-${i}`)], []);
    expected.set(id, `b-row-${i}`);
  }

  const tableId = encodeStorageTableId(TABLE);
  const scanAfterB = await storeB.scan(tableId);
  const scanBodiesAfterB = new Set(scanAfterB.map((d) => d.value.value.body));
  for (const [id, body] of expected) {
    if (body === null) continue;
    expect(scanBodiesAfterB.has(body), `expected B's scan to include "${body}" (id ${internalIdToHex(id.internalId)})`).toBe(true);
  }
  expect(scanAfterB.length).toBe([...expected.values()].filter((v) => v !== null).length);

  const manifestAfterBCommits = await readManifest(bucket, SHARD);
  expect(manifestAfterBCommits).not.toBeNull();

  // ── Step 5: A "revives" as a zombie — its next commit/heartbeat is fenced and poisons it ────────
  await expect(storeA.commitWrite([doc(newDocumentId(TABLE), "zombie-a")], [])).rejects.toBeInstanceOf(FencedError);
  await expect(storeA.heartbeat({ now: now2000 + 10, leaseTtlMs: 1000 })).rejects.toThrow(/poisoned|re-open/i);

  // The manifest still references B's frontier UNCHANGED by A's zombie attempt — the log was not
  // corrupted (same frontier/epoch/writerId as right after B's own commits, above).
  const manifestAfterZombie = await readManifest(bucket, SHARD);
  expect(manifestAfterZombie).not.toBeNull();
  expect(manifestAfterZombie!.manifest.writerId).toBe("B");
  expect(manifestAfterZombie!.manifest.epoch).toBe(2);
  expect(manifestAfterZombie!.manifest.frontierTs).toBe(manifestAfterBCommits!.manifest.frontierTs);
  expect(manifestAfterZombie!.manifest.segments).toEqual(manifestAfterBCommits!.manifest.segments);

  // ── Step 6: a truly-fresh third instance materializes the FINAL combined state byte-identically ──
  // B's lease (acquired at now2000, ttl=1000) expires at now2000+1000; `now <= leaseExpiresAt` still
  // counts as LIVE (per lease.test.ts's 4.2c), so C must acquire strictly AFTER that boundary.
  const storeC = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
  const acquireC = await storeC.acquire({ writerId: "C", leaseTtlMs: 1000, now: now2000 + 1001 });
  expect(acquireC).toEqual({ acquired: true });

  for (const [id, expectedBody] of expected) {
    const hex = internalIdToHex(id.internalId);
    const got = await storeC.get(id);
    if (expectedBody === null) {
      expect(got, `expected id ${hex} to be tombstoned (deleted)`).toBeNull();
    } else {
      expect(got, `expected id ${hex} to exist with body "${expectedBody}"`).not.toBeNull();
      expect(got!.value.value.body).toBe(expectedBody);
    }
  }

  const finalScan = await storeC.scan(tableId);
  const finalBodies = finalScan.map((d) => d.value.value.body).sort();
  const expectedBodies = [...expected.values()].filter((v): v is string => v !== null).sort();
  expect(finalBodies).toEqual(expectedBodies);
  expect(await storeC.count(tableId)).toBe(expectedBodies.length);

  await storeA.close();
  await storeB.close();
  await storeC.close();
}

describe("failover: crashed owner fenced, fresh owner adopts identity + full state (Tier 3 Slice 4, Task 4.4)", () => {
  it("fs — takeover after lease expiry over objectstore-fs", async () => {
    await scenario(freshBucket);
  });
});

// ── Gated: real MinIO container (mirrors bootstrap.e2e.test.ts / snapshot-gc.e2e.test.ts) ──────────

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const RUN = dockerAvailable() && process.env.STACKBASE_OBJECTSTORE_S3 === "1";
const maybeDescribe = RUN ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-objectstore-substrate-failover-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-objectstore-substrate-failover";

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

maybeDescribe("failover over real MinIO", () => {
  beforeAll(async () => {
    endpoint = await startMinio();
  }, 60_000);

  afterAll(() => stopMinio());

  it("minio — takeover after lease expiry over a real S3-compatible bucket", async () => {
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
  }, 60_000);
});
