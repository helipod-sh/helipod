/**
 * Task 6.6 (whole-branch review fixes on Tier 3 Slice 6) — F1 + F2.
 *
 * F1: `serve.ts`'s shutdown handler bounds `objectStoreRelease()` (a live bucket CAS call with no
 * timeout of its own) behind a race so an unreachable bucket at shutdown can't hang the process past
 * a container's grace period. Proven here at the `raceWithTimeout` mechanism level — the exact helper
 * and constant (`OBJECTSTORE_RELINQUISH_TIMEOUT_MS`) `serveCommand`'s shutdown handler uses.
 *
 * F2: the object-store boot fail-fasts (ee-package missing, acquire-timeout "held by", bad
 * `--object-store` URL/creds) used to propagate uncaught out of `startServe` -> `bin.ts`'s raw-stack
 * catch-all. `serveCommand` now mirrors the `--fleet` no-package path: a clean `✗ <message>` + `return
 * 1` for these KNOWN errors, while anything unexpected still surfaces fully.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConvexDir } from "../src/load-modules";
import { bootLoaded, isObjectStoreBootFailFast, OBJECTSTORE_SUBSTRATE_ERR_NO_PACKAGE } from "../src/boot";
import { serveCommand, raceWithTimeout, OBJECTSTORE_RELINQUISH_TIMEOUT_MS, FLEET_ERR_NO_PACKAGE } from "../src/serve";

/* -------------------------------------------------------------------------- */
/* F1 — raceWithTimeout: the shutdown-relinquish bound                        */
/* -------------------------------------------------------------------------- */

describe("raceWithTimeout (F1 — bounds shutdown's objectStoreRelease())", () => {
  it("resolves promptly when the underlying promise resolves quickly (no artificial delay)", async () => {
    const start = Date.now();
    await raceWithTimeout(Promise.resolve("ok"), 2000);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("resolves within the timeout bound (never rejects) when the promise NEVER settles — the hung-bucket case", async () => {
    const start = Date.now();
    const neverResolves = new Promise<never>(() => {}); // simulates an unreachable-bucket socket hang
    await raceWithTimeout(neverResolves, 300);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(1000); // bounded, not hung indefinitely
  });

  it("resolves (does not reject/throw) when the underlying promise rejects", async () => {
    await expect(raceWithTimeout(Promise.reject(new Error("boom")), 300)).resolves.toBeUndefined();
  });

  it("the production bound (OBJECTSTORE_RELINQUISH_TIMEOUT_MS) actually bounds a hung release to a couple seconds, not a real socket timeout (tens of seconds)", async () => {
    const start = Date.now();
    await raceWithTimeout(new Promise<never>(() => {}), OBJECTSTORE_RELINQUISH_TIMEOUT_MS);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(OBJECTSTORE_RELINQUISH_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(OBJECTSTORE_RELINQUISH_TIMEOUT_MS + 1000);
  }, 10_000);
});

/* -------------------------------------------------------------------------- */
/* F2 — isObjectStoreBootFailFast classifier                                  */
/* -------------------------------------------------------------------------- */

describe("isObjectStoreBootFailFast (F2 — distinguishes KNOWN object-store boot errors)", () => {
  it("classifies the ee-package-missing error", () => {
    expect(isObjectStoreBootFailFast(new Error(OBJECTSTORE_SUBSTRATE_ERR_NO_PACKAGE))).toBe(true);
  });

  it("classifies a real acquire-timeout ('held by') error produced by the actual boot path", async () => {
    // Two real writer-node boots racing the SAME file:// bucket, node B's acquire window far too
    // short to ever win — produces the genuine production Error object (not a fabricated string).
    const root = mkdtempSync(join(tmpdir(), "sb-objstore-failfast-"));
    try {
      const loaded = await loadConvexDir("test/fixtures/deploy-v2/convex");
      const nodeA = await bootLoaded({
        loaded,
        components: [],
        dataPath: join(root, "node-a", "db.sqlite"),
        adminKey: "k",
        objectStoreUrl: `file://${join(root, "bucket")}`,
        objectStoreWriterId: "node-a",
        objectStoreLeaseTtlMs: 60_000, // long enough that node A definitely still holds it below
      });
      try {
        let caught: unknown;
        try {
          await bootLoaded({
            loaded,
            components: [],
            dataPath: join(root, "node-b", "db.sqlite"),
            adminKey: "k",
            objectStoreUrl: `file://${join(root, "bucket")}`,
            objectStoreWriterId: "node-b",
            objectStoreAcquireTimeoutMs: 200,
            objectStoreAcquirePollIntervalMs: 50,
          });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/held by 'node-a'/);
        expect(isObjectStoreBootFailFast(caught)).toBe(true);
      } finally {
        await nodeA.objectStoreRelease?.();
        await nodeA.runtime.stopDrivers();
        await nodeA.store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies resolveObjectStore's parse/validation throws (bad scheme, missing bucket, missing creds)", async () => {
    const loaded = await loadConvexDir("test/fixtures/deploy-v2/convex");
    const root = mkdtempSync(join(tmpdir(), "sb-objstore-failfast-badurl-"));
    try {
      let caught: unknown;
      try {
        await bootLoaded({
          loaded,
          components: [],
          dataPath: join(root, "db.sqlite"),
          adminKey: "k",
          objectStoreUrl: "gs://not-a-supported-scheme/bucket",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(isObjectStoreBootFailFast(caught)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT classify an unrelated known error (e.g. the --fleet no-package message) — narrow by design", () => {
    expect(isObjectStoreBootFailFast(new Error(FLEET_ERR_NO_PACKAGE))).toBe(false);
  });

  it("does NOT classify a generic/unexpected error — an unexpected crash must still surface fully", () => {
    expect(isObjectStoreBootFailFast(new Error("ECONNREFUSED 127.0.0.1:9000"))).toBe(false);
    expect(isObjectStoreBootFailFast("boom")).toBe(false);
    expect(isObjectStoreBootFailFast(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* F2 — serveCommand prints a clean ✗ message (not a raw stack) for a bad     */
/* --object-store URL — fast because resolveObjectStore throws synchronously  */
/* before any bucket I/O, so no lease/timeout wait is needed to exercise this.*/
/* -------------------------------------------------------------------------- */

function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

function makeFixtureConvexDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-objstore-failfast-serve-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm);
  symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));
  writeFileSync(
    join(dir, "schema.ts"),
    `
    import { v, defineSchema, defineTable } from "@stackbase/values";
    export default defineSchema({ items: defineTable({ body: v.string() }) });
    `,
  );
  writeFileSync(
    join(dir, "app.ts"),
    `
    import { query } from "@stackbase/executor";
    export const list = query({ handler: async () => [] });
    `,
  );
  mkdirSync(join(dir, "_generated"));
  writeFileSync(join(dir, "_generated", "server.ts"), "// stub generated file\n");
  return dir;
}

describe("serveCommand — object-store fail-fast UX (F2)", () => {
  const OLD_KEY = process.env.STACKBASE_ADMIN_KEY;
  function restoreEnv(): void {
    if (OLD_KEY === undefined) delete process.env.STACKBASE_ADMIN_KEY;
    else process.env.STACKBASE_ADMIN_KEY = OLD_KEY;
  }

  it("a bad --object-store URL prints a clean ✗ message and returns 1 — not a raw stack trace", async () => {
    process.env.STACKBASE_ADMIN_KEY = "test-key";
    const dir = makeFixtureConvexDir();
    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await serveCommand([
        "--dir",
        dir,
        "--data",
        join(mkdtempSync(join(tmpdir(), "sb-objstore-failfast-serve-db-")), "db.sqlite"),
        "--port",
        "0",
        "--no-dashboard",
        "--object-store",
        "gs://unsupported-scheme/bucket",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("✗ stackbase: --object-store URL");
      expect(stderr).toContain("unsupported scheme");
      // The whole point of F2: no raw stack trace (no "at " frame lines, no source-file references).
      expect(stderr).not.toMatch(/\n\s+at /);
      expect(stderr).not.toContain(".ts:");
    } finally {
      process.stderr.write = origWrite;
      restoreEnv();
    }
  });

  // Tier 3 multi-shard single-node serve: `--shards N` (N>1) validation — an object-store WRITER
  // concept, rejected clearly for the combinations that can't mean it.
  async function runServeCapturingStderr(args: string[]): Promise<{ code: number; stderr: string }> {
    process.env.STACKBASE_ADMIN_KEY = "test-key";
    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as typeof process.stderr.write;
    try {
      const code = await serveCommand([
        "--dir",
        makeFixtureConvexDir(),
        "--data",
        join(mkdtempSync(join(tmpdir(), "sb-shards-validation-db-")), "db.sqlite"),
        "--port",
        "0",
        "--no-dashboard",
        ...args,
      ]);
      return { code, stderr };
    } finally {
      process.stderr.write = origWrite;
      restoreEnv();
    }
  }

  it("--shards N (N>1) without --object-store returns 1 with a clean ✗ message", async () => {
    const { code, stderr } = await runServeCapturingStderr(["--shards", "3"]);
    expect(code).toBe(1);
    expect(stderr).toContain("✗ --shards N (N>1) requires --object-store");
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it("--shards with --replica returns 1 (a replica is single-shard)", async () => {
    const { code, stderr } = await runServeCapturingStderr([
      "--object-store",
      `file://${mkdtempSync(join(tmpdir(), "sb-shards-validation-bucket-"))}`,
      "--replica",
      "--shards",
      "3",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("✗ --shards cannot be combined with --replica");
  });
});
