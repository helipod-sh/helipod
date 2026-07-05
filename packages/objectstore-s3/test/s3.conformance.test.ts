/**
 * S3 `ObjectStore` conformance — the ship gate: runs the SHARED conformance suite against a REAL
 * `minio/minio` container (not a mock), proving the CAS fence (`If-Match`/`If-None-Match` conditional
 * PUT → one-winner semantics) actually holds on an S3-class store, per the Tier-3 substrate design.
 *
 * GATED: only runs when docker is available AND `HELIPOD_OBJECTSTORE_S3=1` is set, so the default
 * `bun run --filter @helipod/objectstore-s3 test` stays green (skipped) with no docker/env present.
 * Mirrors `packages/cli/test/storage-e2e.test.ts`'s MinIO container lifecycle.
 */
import { spawnSync } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe } from "vitest";
import { runObjectStoreConformance } from "@helipod/objectstore/test-support/conformance";
import { S3ObjectStore } from "../src/s3-objectstore";

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const RUN = dockerAvailable() && process.env.HELIPOD_OBJECTSTORE_S3 === "1";
const maybeDescribe = RUN ? describe : describe.skip;

const MINIO_CONTAINER = `sb-minio-objectstore-${process.pid}`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";
const BUCKET = "helipod-objectstore-conformance";

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

maybeDescribe("S3ObjectStore — real MinIO container", () => {
  beforeAll(async () => {
    endpoint = await startMinio();
  }, 60_000);

  afterAll(() => stopMinio());

  runObjectStoreConformance(
    "s3 (minio)",
    () =>
      new S3ObjectStore({
        endpoint,
        region: "us-east-1",
        accessKeyId: MINIO_USER,
        secretAccessKey: MINIO_PASS,
        bucket: BUCKET,
        forcePathStyle: true,
      }),
  );
});
