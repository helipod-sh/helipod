/**
 * End-to-end gate for Slice 5 (data migration) through the REAL `startServe` server + the REAL
 * `stackbase migrate export`/`import` CLI clients — the "test through the shipped entrypoint" pattern.
 *
 * The flagship round-trip: an app created on the portable SQLite path, seeded with real data across
 * TWO tables (with an index), EXPORTS to a dump, IMPORTS onto a FRESH deployment, and a query returns
 * IDENTICAL results — same rows, same `_id`s, same `_creationTime`s. This is the same code path the
 * Cloudflare DO host uses (both funnel `/_admin/*` through one handler); the real-workerd DO import is
 * proven separately in `packages/runtime-cloudflare`.
 *
 * Also proves: the table-number collision guard REJECTS a dump whose numbers don't match the target
 * (never silently serving rows under the wrong table), and a wrong admin key is a 401.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServe } from "../src/serve";
import { migrateExportCommand, migrateImportCommand } from "../src/migrate/data";
import { loadConvexDir } from "../src/load-modules";
import { push } from "../src/push-pipeline";
import { writeGenerated } from "@stackbase/codegen";

function fixtureConvexDir(name: string): string {
  return resolve(new URL(".", import.meta.url).pathname, "fixtures", name, "convex");
}

async function regenerate(functionsDir: string): Promise<void> {
  const loaded = await loadConvexDir(functionsDir);
  const { generated } = push(loaded, []);
  writeGenerated(generated.files, join(functionsDir, "_generated"));
}

function tmpDb(tag: string): string {
  return join(mkdtempSync(join(tmpdir(), `sbmig-${tag}-`)), "db.sqlite");
}

async function run(url: string, path: string, args: unknown = {}): Promise<unknown> {
  const res = await fetch(`${url}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  const body = (await res.json()) as { value?: unknown; error?: string };
  if (!res.ok) throw new Error(`run ${path} failed: ${body.error}`);
  return body.value;
}

describe("stackbase migrate export/import — end-to-end through the real serve server", () => {
  it("SQLite → dump → fresh SQLite reproduces identical rows/ids/_creationTime; guard rejects a clash", async () => {
    const dir = fixtureConvexDir("migrate-data");
    await regenerate(dir);
    const dumpFile = join(mkdtempSync(join(tmpdir(), "sbmig-dump-")), "dump.json");

    let source: Awaited<ReturnType<typeof startServe>> | undefined;
    let target: Awaited<ReturnType<typeof startServe>> | undefined;
    try {
      // 1. Source deployment: boot, seed real data across two tables.
      source = await startServe({
        functionsDir: dir,
        dataPath: tmpDb("src"),
        ip: "127.0.0.1",
        port: 0,
        adminKey: "src-key",
        dashboard: false,
        allowDeploy: false,
      });
      await run(source.server.url, "app:seed");
      const srcMessages = await run(source.server.url, "app:allMessages");
      const srcUsers = await run(source.server.url, "app:allUsers");
      expect((srcMessages as unknown[]).length).toBe(3);
      expect((srcUsers as unknown[]).length).toBe(2);

      // 2. Export via the real CLI client → dump.json.
      const exportCode = await migrateExportCommand(["--url", source.server.url, "--out", dumpFile, "--admin-key", "src-key"]);
      expect(exportCode).toBe(0);
      const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as {
        format: string;
        documents: unknown[];
        tableNumbers: Record<string, number>;
      };
      expect(dump.format).toBe("stackbase-migration-dump");
      // 5 docs total (3 messages + 2 users), plus the dump carries table numbers.
      expect(dump.documents.length).toBe(5);
      expect(dump.tableNumbers.messages).toBeGreaterThan(0);
      expect(dump.tableNumbers.users).toBeGreaterThan(0);

      // 3. FRESH target deployment (empty store), same schema.
      target = await startServe({
        functionsDir: dir,
        dataPath: tmpDb("dst"),
        ip: "127.0.0.1",
        port: 0,
        adminKey: "dst-key",
        dashboard: false,
        allowDeploy: false,
      });
      expect((await run(target.server.url, "app:allMessages") as unknown[]).length).toBe(0);

      // 4. A wrong admin key is rejected before anything is applied.
      const unauth = await fetch(`${target.server.url}/_admin/import`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: readFileSync(dumpFile, "utf8"),
      });
      expect(unauth.status).toBe(401);

      // 5. A dump whose table numbers clash with the target is REJECTED (the collision guard) — never
      //    silently served under the wrong table.
      const clashed = JSON.parse(readFileSync(dumpFile, "utf8")) as { tableNumbers: Record<string, number> };
      clashed.tableNumbers = { ...clashed.tableNumbers, messages: clashed.tableNumbers.messages! + 12345 };
      const clashRes = await fetch(`${target.server.url}/_admin/import`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer dst-key" },
        body: JSON.stringify(clashed),
      });
      expect(clashRes.status).toBe(400);
      expect(((await clashRes.json()) as { error?: string }).error).toMatch(/wrong table|number/i);
      // Target still empty after the rejection.
      expect((await run(target.server.url, "app:allMessages") as unknown[]).length).toBe(0);

      // 6. Import the real dump via the CLI client.
      const importCode = await migrateImportCommand(["--url", target.server.url, "--in", dumpFile, "--admin-key", "dst-key"]);
      expect(importCode).toBe(0);

      // 7. THE GATE: the target now returns byte-identical rows (ids + _creationTime included).
      const dstMessages = await run(target.server.url, "app:allMessages");
      const dstUsers = await run(target.server.url, "app:allUsers");
      expect(dstMessages).toEqual(srcMessages);
      expect(dstUsers).toEqual(srcUsers);

      // 8. The imported store is LIVE: a fresh mutation commits on top without a ts collision.
      const before = (await run(target.server.url, "app:allUsers") as unknown[]).length;
      const insertRes = await fetch(`${target.server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:seed", args: {} }),
      });
      expect(insertRes.status).toBe(200);
      expect((await run(target.server.url, "app:allUsers") as unknown[]).length).toBe(before + 2);
    } finally {
      await source?.server.close();
      source?.store.close();
      await target?.server.close();
      target?.store.close();
    }
  }, 30000);
});
