/**
 * Data migration (Slice 5) proven inside REAL Durable Objects (workerd) — the highest-fidelity proof
 * that a dump exports FROM and imports INTO real DO-SQLite (`ctx.storage.sql`), short of a live
 * `wrangler deploy`. Two independent DO instances (independent DO-SQLite) stand in for the two
 * topologies: commit data into "src", `GET /_admin/export`, `POST /_admin/import` into a FRESH "dst",
 * then read it back — identical rows, ids, and `_creationTime`. Because the same app boots both DOs,
 * their table numbers match, so the round-trip is clean; a mutated dump is REJECTED by the collision
 * guard, never silently served under the wrong table.
 *
 * This is the DO tier of the Slice-5 gate. The one thing it does NOT cover (needs a real Cloudflare
 * account this worktree has no login for): a cross-account container+R2 → DO network migration. The
 * code path exercised here — export/import over real DO-SQLite via the admin endpoints — is identical.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

interface DoNs {
  idFromName(n: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
const DO = () => (env as { HELIPOD_DO: DoNs }).HELIPOD_DO;
const stub = (name: string) => DO().get(DO().idFromName(name));
const ADMIN = "workerd-test-admin-key";

function run(path: string, args: unknown): Request {
  return new Request("https://do.test/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
}
function adminGet(path: string, key = ADMIN): Request {
  return new Request(`https://do.test${path}`, { headers: { authorization: `Bearer ${key}` } });
}
function adminPost(path: string, body: string, key = ADMIN): Request {
  return new Request(`https://do.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
  });
}

describe("data migration on REAL workerd (DO-SQLite export/import)", () => {
  it("commits into src, exports, imports into a fresh dst — identical rows/ids/_creationTime", async () => {
    const src = stub("mig-src");
    const conv = "mig-c1";
    await src.fetch(run("messages:send", { conversationId: conv, body: "first" }));
    await src.fetch(run("messages:send", { conversationId: conv, body: "second" }));

    // Capture the source's full docs (incl. _id + _creationTime).
    const srcList = ((await (await src.fetch(run("messages:list", { conversationId: conv }))).json()) as { value: unknown[] }).value;
    expect((srcList as Array<{ body: string }>).map((m) => m.body)).toEqual(["first", "second"]);

    // Export from the SOURCE DO over real DO-SQLite.
    const exportRes = await src.fetch(adminGet("/_admin/export"));
    expect(exportRes.status).toBe(200);
    const dumpText = await exportRes.text();
    const dump = JSON.parse(dumpText) as { format: string; documents: unknown[]; tableNumbers: Record<string, number> };
    expect(dump.format).toBe("helipod-migration-dump");
    expect(dump.documents.length).toBeGreaterThanOrEqual(2);
    expect(dump.tableNumbers.messages).toBeGreaterThan(0);

    // A FRESH target DO is empty for this conversation.
    const dst = stub("mig-dst");
    const emptyList = ((await (await dst.fetch(run("messages:list", { conversationId: conv }))).json()) as { value: unknown[] }).value;
    expect(emptyList).toEqual([]);

    // Import the dump INTO the fresh DO's real DO-SQLite.
    const importRes = await dst.fetch(adminPost("/_admin/import", dumpText));
    expect(importRes.status).toBe(200);
    expect(((await importRes.json()) as { ok: boolean }).ok).toBe(true);

    // THE GATE: the target returns byte-identical rows (ids + _creationTime included).
    const dstList = ((await (await dst.fetch(run("messages:list", { conversationId: conv }))).json()) as { value: unknown[] }).value;
    expect(dstList).toEqual(srcList);
  });

  it("REJECTS a dump whose table numbers clash with the target (the collision guard)", async () => {
    const src = stub("mig-src2");
    await src.fetch(run("messages:send", { conversationId: "g1", body: "x" }));
    const dump = JSON.parse(await (await src.fetch(adminGet("/_admin/export"))).text()) as {
      tableNumbers: Record<string, number>;
    };
    dump.tableNumbers = { ...dump.tableNumbers, messages: dump.tableNumbers.messages! + 9999 };

    const dst = stub("mig-dst2");
    const res = await dst.fetch(adminPost("/_admin/import", JSON.stringify(dump)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/wrong table|number/i);
  });

  it("rejects export/import with a wrong admin key (401)", async () => {
    const s = stub("mig-auth");
    expect((await s.fetch(adminGet("/_admin/export", "wrong"))).status).toBe(401);
    expect((await s.fetch(adminPost("/_admin/import", "{}", "wrong"))).status).toBe(401);
  });
});
