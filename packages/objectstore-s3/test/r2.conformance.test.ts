/**
 * Cloudflare R2 `ObjectStore` conformance — the Tier-3-on-Cloudflare GATE: runs the SHARED
 * conformance suite against a REAL R2 bucket over R2's S3-compatible endpoint, proving the CAS fence
 * (`If-Match`/`If-None-Match` conditional PUT → one-winner semantics) actually holds on R2 and not
 * merely on MinIO/AWS. This is the single hard prerequisite for ANY Cloudflare deployment story: the
 * whole object-store substrate's single-writer lease is a compare-and-swap on the manifest, so if R2
 * diverges from S3 conditional-PUT semantics the substrate cannot run there at all.
 *
 * Deliberately NO Cloudflare compute: this exercises the shipped `S3ObjectStore` against R2's S3 API,
 * so it needs no Worker/Container/wrangler — only a bucket + an S3-API token.
 *
 * SCOPE: this proves the S3-API path only. The native Workers R2 binding (`env.BUCKET.put(...,
 * {onlyIf})`) is a DIFFERENT surface that signals a failed precondition by returning `null` rather
 * than throwing — an `objectstore-r2` binding adapter would need its own conformance run.
 *
 * GATED: only runs when `STACKBASE_OBJECTSTORE_R2=1` AND the four R2_* vars are set, so the default
 * `bun run --filter @stackbase/objectstore-s3 test` stays green (skipped) with no R2 account present.
 * Mirrors `./s3.conformance.test.ts`'s gating shape.
 *
 *   STACKBASE_OBJECTSTORE_R2=1 \
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... \
 *   bun run --filter @stackbase/objectstore-s3 test
 *
 * RUN ISOLATION: unlike the MinIO suite (fresh container per run ⇒ always-clean fixed keys), R2 is a
 * real PERSISTENT bucket, so the suite's fixed keys (`cas/create`, …) would collide with the previous
 * run — a create-only `casPut` would throw `CasConflict` and fail the test falsely. Each run therefore
 * gets a unique key prefix. The prefix is what makes a re-run correct; `teardown` is only hygiene, so
 * a crashed run (teardown skipped) still cannot poison the next one.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe } from "vitest";
import { runObjectStoreConformance } from "@stackbase/objectstore/test-support/conformance";
import type { ObjectStore } from "@stackbase/objectstore";
import { S3ObjectStore } from "../src/s3-objectstore";

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const BUCKET = process.env.R2_BUCKET ?? "";

const RUN =
  process.env.STACKBASE_OBJECTSTORE_R2 === "1" &&
  Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET);
const maybeDescribe = RUN ? describe : describe.skip;

/** R2's S3-compatible endpoint. `region` must be `auto` — R2 has no regions.
 *  `R2_ENDPOINT` overrides the derived URL: needed for a jurisdiction-specific bucket
 *  (`<account>.eu.r2.cloudflarestorage.com`), and lets this harness be dry-run against a local MinIO
 *  to prove the harness itself before spending an R2 token — so a failure here indicts R2, not the rig. */
const ENDPOINT = process.env.R2_ENDPOINT || `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const REGION = "auto";

/** One unique namespace per run — see RUN ISOLATION above. */
const RUN_PREFIX = `conformance/${Date.now()}-${randomBytes(4).toString("hex")}/`;

/** Namespaces every key under `prefix` so a run can't collide with a previous one's leftovers.
 *  `list` must STRIP the prefix back off: the conformance suite asserts on the bare keys it passed in. */
class PrefixedObjectStore implements ObjectStore {
  constructor(
    private readonly inner: ObjectStore,
    private readonly prefix: string,
  ) {}

  putImmutable(key: string, body: Uint8Array): Promise<void> {
    return this.inner.putImmutable(this.prefix + key, body);
  }

  casPut(key: string, body: Uint8Array, ifMatch: string | null): Promise<{ etag: string }> {
    return this.inner.casPut(this.prefix + key, body, ifMatch);
  }

  get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    return this.inner.get(this.prefix + key);
  }

  async list(prefix: string): Promise<string[]> {
    const keys = await this.inner.list(this.prefix + prefix);
    return keys.map((k) => (k.startsWith(this.prefix) ? k.slice(this.prefix.length) : k));
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(this.prefix + key);
  }

  assertCasSupported(): Promise<void> {
    return this.inner.assertCasSupported();
  }
}

function makeR2Store(): ObjectStore {
  return new S3ObjectStore({
    endpoint: ENDPOINT,
    region: REGION,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    bucket: BUCKET,
    forcePathStyle: true,
  });
}

/** Best-effort sweep of this run's namespace. Hygiene only — correctness comes from `RUN_PREFIX`. */
async function sweepRunPrefix(): Promise<void> {
  const store = makeR2Store();
  const keys = await store.list(RUN_PREFIX);
  await Promise.all(keys.map((k) => store.delete(k)));
}

if (!RUN && process.env.STACKBASE_OBJECTSTORE_R2 === "1") {
  // Opted in but under-configured — say so loudly rather than silently skipping.
  console.warn(
    "[r2.conformance] STACKBASE_OBJECTSTORE_R2=1 but R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / " +
      "R2_SECRET_ACCESS_KEY / R2_BUCKET are not all set — skipping.",
  );
}

maybeDescribe("S3ObjectStore — real Cloudflare R2 bucket (S3 API)", () => {
  afterAll(async () => {
    await sweepRunPrefix();
  }, 60_000);

  runObjectStoreConformance("r2 (s3 api)", () => new PrefixedObjectStore(makeR2Store(), RUN_PREFIX));
});
