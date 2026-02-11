/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 5.3 — the slice's HEADLINE E2E (plan `2026-07-13-tier3-slice5-replicas-reactivity.md`, design
 * record §7/§8): a mutation committed on a WRITER node fans out reactively to a live subscription on
 * a SEPARATE REPLICA node whose only link to the writer is the object-storage bucket — no shared
 * database, no direct process-to-process link.
 *
 * `scenario(makeBucket)`:
 *   1. WRITER node — `ObjectStoreDocStore.open`+`acquire` shard "0", a real `createEmbeddedRuntime`,
 *      the Slice-2 `notes:add`/`notes:list` fixture (mirrors `runtime.e2e.test.ts`). Commits an
 *      initial mutation.
 *   2. REPLICA node — a FRESH local `SqliteDocStore`, bootstrapped via a throwaway
 *      `ObjectStoreDocStore.open` (NO acquire — a replica never claims the shard) over the SAME
 *      bucket, then a SECOND independent `createEmbeddedRuntime` running straight over that bare
 *      local store (no object-storage interception — the replica never commits), plus an
 *      `ObjectStoreReplicaTailer` whose `onInvalidation` sink mirrors the shipped fleet
 *      `invalidationSink` (`ee/packages/fleet/src/node.ts` ~:1358): `observeTimestamp` → convert the
 *      applied keys/docs to point ranges → `handler.notifyWrites` → `notifyExternalCommit`.
 *   3. THE HEADLINE: open a live subscription on the REPLICA runtime, commit a NEW mutation through
 *      the WRITER runtime, drive the tailer, and assert the REPLICA's subscription — which never
 *      talked to the writer process — fires with the writer's new row.
 *   4. `readGlobalFrontier` over the bucket has advanced to the writer's frontier.
 *
 * Runs against `objectstore-fs` (always-on, no docker) AND, gated, against a real `minio/minio`
 * container — mirrors `bootstrap.e2e.test.ts`'s lifecycle. The default
 * `bun run --filter @stackbase/objectstore-substrate test` must stay green with the MinIO variant
 * skipped (no docker/env required).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { decodeStorageIndexId, encodeStorageIndexId, encodeStorageTableId } from "@stackbase/id-codec";
import { keySuccessor, serializeKeyRange, indexKeyspaceId, tableKeyspaceId, type SerializedKeyRange } from "@stackbase/index-key-codec";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { ObjectStore } from "@stackbase/objectstore";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { S3ObjectStore } from "@stackbase/objectstore-s3";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { ObjectStoreReplicaTailer, type AppliedInvalidation } from "../src/replica-tailer";
import { readGlobalFrontier } from "../src/frontier";

const SHARD = "0";
const NOTES_TABLE_NUMBER = 40011;

// Same fixture shape as `runtime.e2e.test.ts` (Task 2.4) — a `notes` schema + `notes:add`/
// `notes:list` module pair, and a hand-built `SimpleIndexCatalog` (the same thing
// `packages/cli`'s `loadProject`/`composeComponents` builds from a schema at codegen time).
const schema = defineSchema({ notes: defineTable({ body: v.string() }) });

const modules: Record<string, RegisteredFunction> = {
  "notes:add": mutation<{ body: string }, string>({
    handler: (ctx, { body }) => ctx.db.insert("notes", { body }),
  }),
  "notes:list": query<Record<string, never>, string[]>({
    handler: async (ctx) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await (ctx.db.query("notes", "by_creation") as any).collect()).map((d: { body: string }) => d.body),
  }),
};

function notesCatalog(): SimpleIndexCatalog {
  const documentType = schema.export().tables.notes!.documentType;
  return new SimpleIndexCatalog()
    .addTable("notes", NOTES_TABLE_NUMBER, documentType)
    .addIndex({
      table: "notes",
      tableNumber: NOTES_TABLE_NUMBER,
      index: "by_creation",
      fields: [],
      indexId: encodeStorageIndexId(NOTES_TABLE_NUMBER, "by_creation"),
    });
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

// ── Point-range conversion — mirrors `ee/packages/fleet/src/ranges.ts`'s `keyToPointRange`/
// `docKeyToPointRange` byte-for-byte (see that file's doc for the full rationale of the decode/
// recompose step). Inlined here rather than imported from `@stackbase/fleet`: the plan is explicit
// that `objectstore-substrate` must not depend on `@stackbase/fleet` even from its own tests — "the
// runtime wiring is the composer's job (the E2E, mirroring `invalidationSink`)". ─────────────────
function keyToPointRange(indexId: string, key: Uint8Array): SerializedKeyRange {
  const { tableNumber, indexName } = decodeStorageIndexId(indexId);
  const keyspace = indexKeyspaceId(encodeStorageTableId(tableNumber), indexName);
  return serializeKeyRange({ keyspace, start: key, end: keySuccessor(key) });
}

function docKeyToPointRange(tableId: string, internalId: Uint8Array): SerializedKeyRange {
  const keyspace = tableKeyspaceId(tableId);
  return serializeKeyRange({ keyspace, start: internalId, end: keySuccessor(internalId) });
}

/** Structural read-only view of the server messages a loopback connection pushes (avoids importing
 *  `@stackbase/sync` just for its message types — mirrors `writer-invalidation.test.ts`). */
type ServerMsg = { type: string; modifications?: Array<{ type: string; queryId?: number; value?: unknown }> };

function latestQueryValue(msgs: ServerMsg[], queryId: number): unknown {
  let value: unknown;
  for (const m of msgs) {
    if (m.type !== "Transition") continue;
    for (const mod of m.modifications ?? []) {
      if (mod.type === "QueryUpdated" && mod.queryId === queryId) value = mod.value;
    }
  }
  return value;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const dirs: string[] = [];
async function freshFsBucket(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-crossnode-e2e-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The runtimes/tailer/connection this scenario opens, so a caller (or the shared teardown) can
 *  close everything even if an assertion throws mid-scenario. */
interface Handles {
  writerStore: ObjectStoreDocStore;
  writerRuntime: EmbeddedRuntime;
  replicaLocal: SqliteDocStore;
  replicaRuntime: EmbeddedRuntime;
  tailer: ObjectStoreReplicaTailer;
}

async function teardown(h: Partial<Handles>): Promise<void> {
  h.tailer?.stop();
  await h.writerStore?.close();
  await h.replicaLocal?.close();
}

async function scenario(makeBucket: () => Promise<ObjectStore>): Promise<void> {
  const bucket = await makeBucket();
  const h: Partial<Handles> = {};

  try {
    // ── 1. WRITER node ────────────────────────────────────────────────────────────────────────
    const writerStore = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
    h.writerStore = writerStore;
    const acquired = await writerStore.acquire({ writerId: "writer", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
    if (!acquired.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${acquired.heldBy})`);
    const writerRuntime = await createEmbeddedRuntime({ store: writerStore, catalog: notesCatalog(), modules });
    h.writerRuntime = writerRuntime;

    await writerRuntime.run<string>("notes:add", { body: "first" });

    // ── 2. REPLICA node ───────────────────────────────────────────────────────────────────────
    const replicaLocal = freshLocal();
    h.replicaLocal = replicaLocal;
    // Bootstrap `replicaLocal` from the bucket alone (NO acquire — a replica never claims the
    // shard). The wrapper itself is a throwaway: the replica's runtime runs straight over the
    // bare `replicaLocal` it just materialized (the tailer applies onto it directly too), so it's
    // deliberately never `close()`d (that would close the shared `replicaLocal` out from under
    // both the runtime and the tailer).
    await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: replicaLocal });

    const replicaRuntime = await createEmbeddedRuntime({ store: replicaLocal, catalog: notesCatalog(), modules });
    h.replicaRuntime = replicaRuntime;

    // Sanity: the replica bootstrapped the writer's pre-existing row through its OWN runtime, no
    // coordination beyond the bucket.
    const bootstrapped = (await replicaRuntime.run<string[]>("notes:list", {})).value;
    expect(bootstrapped).toEqual(["first"]);

    // The reactive sink — mirrors the shipped fleet `invalidationSink` (`node.ts` ~:1358)
    // byte-for-byte: observe the applied ts BEFORE fanning ranges into the sync handler (so the
    // query oracle's re-run actually reads the newly-applied rows), then notify both the live
    // query subscriptions and any driver `onCommit` wake.
    const invalidationSink = async (inv: AppliedInvalidation): Promise<void> => {
      replicaRuntime.observeTimestamp(inv.newMaxTs);
      const ranges = [
        ...inv.writtenKeys.map((k) => keyToPointRange(k.indexId, k.key)),
        ...inv.writtenDocs.map((d) => docKeyToPointRange(d.tableId, d.internalId)),
      ];
      const commitTs = Number(inv.newMaxTs);
      await replicaRuntime.handler.notifyWrites({ tables: inv.writtenTables, ranges, commitTs });
      replicaRuntime.notifyExternalCommit({ tables: inv.writtenTables, ranges, commitTs });
    };

    const tailer = new ObjectStoreReplicaTailer({ objectStore: bucket, shard: SHARD, local: replicaLocal, onInvalidation: invalidationSink });
    h.tailer = tailer;

    // ── 3. THE HEADLINE — a live subscription on the REPLICA, a commit on the WRITER ────────────
    const conn = replicaRuntime.connect("replica-session");
    const serverMsgs: ServerMsg[] = [];
    conn.onMessage((m) => serverMsgs.push(m as ServerMsg));
    try {
      await conn.send({
        type: "ModifyQuerySet",
        add: [{ queryId: 1, udfPath: "notes:list", args: {} }],
        remove: [],
      });
      expect((latestQueryValue(serverMsgs, 1) as string[])?.sort()).toEqual(["first"]);

      // The writer commits a NEW mutation through ITS OWN runtime — the replica has no direct link
      // to it, only the bucket.
      await writerRuntime.run<string>("notes:add", { body: "second" });

      // Drive the tailer directly (no `start()`/wall-clock poll needed in a test) until it's
      // caught up to the writer's new frontier (ts=2) and has applied + invalidated.
      for (let i = 0; i < 200 && tailer.appliedMaxTs < 2n; i++) {
        await tailer.tick();
        if (tailer.appliedMaxTs < 2n) await new Promise((r) => setTimeout(r, 10));
      }
      expect(tailer.appliedMaxTs).toBe(2n);

      // The REPLICA's live subscription — opened before the writer's second commit, never talking
      // to the writer process — fires with the writer's new row: cross-node reactive propagation
      // through object storage alone.
      await waitUntil(() => {
        const v = latestQueryValue(serverMsgs, 1);
        return Array.isArray(v) && v.length === 2;
      });
      expect((latestQueryValue(serverMsgs, 1) as string[]).sort()).toEqual(["first", "second"]);

      // A plain re-run on the replica's runtime (not just the pushed subscription) agrees too —
      // the oracle itself observed the writer's new ts, not just the sync handler's notify path.
      const replicaList = (await replicaRuntime.run<string[]>("notes:list", {})).value;
      expect(replicaList.sort()).toEqual(["first", "second"]);

      // ── 4. Cross-shard frontier advanced to the writer's frontier ──────────────────────────
      const writerFrontier = await readGlobalFrontier(bucket, [SHARD]);
      expect(writerFrontier).toBe(2n);
      expect(tailer.appliedMaxTs).toBe(writerFrontier);
    } finally {
      conn.close();
    }
  } finally {
    await teardown(h);
  }
}

describe("cross-node reactivity: a writer's commit fans out to a live subscription on a separate replica, through object storage alone", () => {
  it("fs — headline cross-node propagation over objectstore-fs", async () => {
    await scenario(freshFsBucket);
  });
});

// ── Gated: real MinIO container (mirrors bootstrap.e2e.test.ts) ────────────────────────────────

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const RUN = dockerAvailable() && process.env.STACKBASE_OBJECTSTORE_S3 === "1";
const maybeDescribe = RUN ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-objectstore-substrate-crossnode-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "stackbase-objectstore-substrate-crossnode";

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

maybeDescribe("cross-node reactivity over real MinIO", () => {
  beforeAll(async () => {
    endpoint = await startMinio();
  }, 60_000);

  afterAll(() => stopMinio());

  it("minio — headline cross-node propagation over a real S3-compatible bucket", async () => {
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
