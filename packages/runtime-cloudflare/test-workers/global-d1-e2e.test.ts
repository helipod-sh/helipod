/**
 * M2b Task 9 — the ship gate for the whole `.global()` D1 chain: schema `.global()` (Task 1) through
 * catalog `mode` (Task 2/3), kernel routing (Task 6), `GlobalTxn` RYOW overlay (Task 5), the atomic
 * `commitBatch` flush (Task 4/7), and the CF DO boot injection (this task) — proven against a REAL
 * Durable Object (workerd) with a REAL D1 binding (`env.DB`, miniflare's actual D1/SQLite dialect),
 * not a stand-in. Serial lane (`*-e2e.test.ts`).
 *
 * Five scenarios (brief §Task 9 Step 3):
 *   1. a `.global()` insert commits to D1 and a later query reads it back;
 *   2. a same-mutation read-your-own-writes (insert then read before the handler returns);
 *   3. a global-unique violation → a coded write rejection (the duplicate is never applied);
 *   4. a mutation writing a sharded/root table AND a `.global()` table → `CrossStoreWriteError`,
 *      with NEITHER store's write surviving;
 *   5. a `.global()`-only mutation that throws after its global insert → D1 untouched (abort-safety).
 *
 * Does NOT assert reactive subscription updates on `.global()` tables — global tables are not
 * reactive in M2b (M2c).
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

interface DoNs {
  idFromName(n: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
const DO = () => (env as { GLOBAL_D1_DO: DoNs }).GLOBAL_D1_DO;
const stub = (name: string) => DO().get(DO().idFromName(name));

function post(path: string, bodyObj: unknown): Request {
  return new Request(`https://do.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

async function run(s: ReturnType<typeof stub>, path: string, args: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await s.fetch(post("/api/run", { path, args }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe(".global() D1-backed tables on a REAL Durable Object + REAL D1 (workerd)", () => {
  it("1. a .global() insert commits to D1 and a query reads it back", async () => {
    const s = stub("scenario-1");
    const created = await run(s, "counters:create", { key: "k1", value: 42 });
    expect(created.status).toBe(200);
    expect(typeof created.body.value).toBe("string");

    const read = await run(s, "counters:getByKey", { key: "k1" });
    expect(read.status).toBe(200);
    expect(read.body.value).toMatchObject({ key: "k1", value: 42 });
  });

  it("2. same-mutation read-your-own-writes (insert then read before the handler returns)", async () => {
    const s = stub("scenario-2");
    const res = await run(s, "counters:createAndReadBack", { key: "k2", value: 7 });
    expect(res.status).toBe(200);
    const value = res.body.value as { id: string; byId: { key: string; value: number } | null; byIndexCount: number };
    expect(typeof value.id).toBe("string");
    expect(value.byId).toMatchObject({ key: "k2", value: 7 });
    expect(value.byIndexCount).toBe(1);
  });

  it("3. a global-unique violation is a coded write rejection; the duplicate is never applied", async () => {
    const s = stub("scenario-3");
    const first = await run(s, "counters:create", { key: "dup", value: 1 });
    expect(first.status).toBe(200);

    const second = await run(s, "counters:create", { key: "dup", value: 2 });
    expect(second.status).not.toBe(200);
    expect(typeof second.body.error).toBe("string");
    expect(String(second.body.error).toLowerCase()).toContain("unique constraint");
    expect(typeof second.body.code).toBe("string"); // a coded rejection, not a bare/unshaped 500

    // The duplicate never landed — the original value survives untouched.
    const read = await run(s, "counters:getByKey", { key: "dup" });
    expect(read.body.value).toMatchObject({ key: "dup", value: 1 });
  });

  it("4. a sharded/root + .global() co-write throws CrossStoreWriteError; NEITHER store is written", async () => {
    const s = stub("scenario-4");
    const co = await run(s, "counters:coWrite", { key: "co1", value: 1, name: "conflict-item" });
    expect(co.status).not.toBe(200);
    expect(String(co.body.error).toLowerCase()).toContain("global");
    expect(String(co.body.error).toLowerCase()).toContain("not both in one mutation");

    // The .global() (D1) write never landed.
    const read = await run(s, "counters:getByKey", { key: "co1" });
    expect(read.body.value).toBeNull();

    // The root/local (MVCC) write never landed either.
    const list = await run(s, "localItems:list", {});
    const names = (list.body.value as Array<{ name: string }>).map((d) => d.name);
    expect(names).not.toContain("conflict-item");
  });

  it("5. a .global()-only mutation that throws after its global insert leaves D1 untouched", async () => {
    const s = stub("scenario-5");
    const res = await run(s, "counters:insertThenThrow", { key: "abort1", value: 1 });
    expect(res.status).not.toBe(200);
    expect(String(res.body.error)).toContain("deliberate abort after global insert");

    const read = await run(s, "counters:getByKey", { key: "abort1" });
    expect(read.body.value).toBeNull();
  });
});
