// Integration tests for the Receipted Outbox OWNER-side classification (verdict §(c)), exercised
// through the FULL EmbeddedRuntime: the receipts guard registered at construction, the classify →
// run → replay path in `runtime.run`/the sync `runMutation`, the zero-write standalone receipt, and
// the reactive fan-out skip on a replay. Real SqliteDocStore, real transactor, real guard chain.
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { defineSchema, defineTable, v, convexToJson, type Value } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { EmbeddedRuntime } from "../src/index";
import type { ServerMessage } from "@stackbase/sync";

// Over `CLIENT_VERDICT_VALUE_CAP_BYTES` (64KB) once JSON-quoted — the fill's oversized-drop case.
const OVERSIZED_VALUE = "x".repeat(70_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeRuntime(opts?: { externalReceiptsGuard?: boolean }): Promise<EmbeddedRuntime> {
  const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const modules = {
    "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
    "app:noop": mutation(async (_ctx: any, a: { n: number }) => ({ echoed: a.n })), // writes nothing
    "app:boom": mutation(async () => {
      throw new Error("deterministic boom");
    }),
    // A real write (so the guard runs) whose RETURN value is oversized — distinct from the doc body.
    "app:bigReturn": mutation(async (ctx: any, a: { body: string }) => {
      await ctx.db.insert("notes", { body: a.body });
      return OVERSIZED_VALUE;
    }),
    "app:list": query(async (ctx: any) => (await ctx.db.query("notes", "by_creation").collect()).map((d: any) => d.body)),
  };
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: modules }, []);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog,
    modules: c.moduleMap,
    componentNames: c.componentNames,
    contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry,
    bootSteps: c.bootSteps,
    drivers: c.drivers,
    tableNumbers: c.tableNumbers,
    ...(opts?.externalReceiptsGuard ? { externalReceiptsGuard: true } : {}),
  });
}

const dedup = (clientId: string, seq: number) => ({ dedup: { clientId, seq } });

describe("client-dedup classification (runtime.run at the owner)", () => {
  it("a write-mutation runs once; a resend replays `applied` WITH the real value (the post-run guard-receipt fill, T5-review FIX 2) and does NOT re-run", async () => {
    const r = await makeRuntime();
    const first = await r.run("app:add", { body: "hello" }, dedup("c1", 1));
    expect(first.committed).toBe(true);
    expect(first.clientReplay).toBeUndefined();

    const second = await r.run("app:add", { body: "hello" }, dedup("c1", 1));
    expect(second.clientReplay).toMatchObject({ verdict: "applied" });
    expect(second.clientReplay!.valueMissing).toBeUndefined();
    expect(second.clientReplay!.value).toEqual(convexToJson(first.value as Value));
    expect(second.committed).toBe(false);

    // Exactly-once effect: the note table has ONE row, not two.
    const list = await r.run("app:list", {});
    expect(list.value).toEqual(["hello"]);
  });

  it("an oversized write-mutation return value is dropped by the fill (replay stays valueMissing, same cap `recordClientVerdict` uses)", async () => {
    const r = await makeRuntime();
    const first = await r.run("app:bigReturn", { body: "big" }, dedup("c1b", 1));
    expect(first.committed).toBe(true);
    expect(first.value).toBe(OVERSIZED_VALUE);

    const second = await r.run("app:bigReturn", { body: "big" }, dedup("c1b", 1));
    expect(second.clientReplay).toMatchObject({ verdict: "applied", valueMissing: true });
    expect(second.clientReplay!.value).toBeUndefined();
  });

  it("a ZERO-WRITE successful mutation records its receipt standalone (WITH the return value), and replays it", async () => {
    const r = await makeRuntime();
    const first = await r.run("app:noop", { n: 7 }, dedup("c2", 1));
    expect(first.committed).toBe(false); // no doc rows
    expect((first.value as any).echoed).toBe(7);

    const second = await r.run("app:noop", { n: 7 }, dedup("c2", 1));
    expect(second.clientReplay).toMatchObject({ verdict: "applied" });
    expect(second.clientReplay!.valueMissing).toBeUndefined();
    expect((second.clientReplay!.value as any).echoed).toBe(7);
  });

  it("a deterministic failure records a `failed` verdict; the first call throws, a resend replays the terminal code", async () => {
    const r = await makeRuntime();
    await expect(r.run("app:boom", {}, dedup("c3", 1))).rejects.toThrow(/boom/);

    const resend = await r.run("app:boom", {}, dedup("c3", 1));
    expect(resend.clientReplay).toMatchObject({ verdict: "failed" });
    expect(resend.clientReplay!.code).toBeTruthy();
  });

  it("a seq at or below the floor with no record is STALE_CLIENT (loudly disowned, never re-run)", async () => {
    const r = await makeRuntime();
    // Advance the floor for (identity="", clientId=c4) to 5 without any record present.
    await r.store.pruneClientMutations("", "c4", { ackedThrough: 5 });
    const stale = await r.run("app:add", { body: "x" }, dedup("c4", 3));
    expect(stale.clientReplay).toMatchObject({ verdict: "stale", code: "STALE_CLIENT" });
    // Above the floor with no record → runs normally.
    const fresh = await r.run("app:add", { body: "y" }, dedup("c4", 6));
    expect(fresh.committed).toBe(true);
    expect(fresh.clientReplay).toBeUndefined();
  });

  it("a mutation with NO dedup key writes NO receipt (old-client bit-compat)", async () => {
    const r = await makeRuntime();
    await r.run("app:add", { body: "z" });
    expect(await r.store.getClientVerdict("", "anyClient", 1)).toBeNull();
    expect(await r.store.getClientFloor("", "anyClient")).toBeNull();
  });

  it("`externalReceiptsGuard` makes `create()` register NO receipts guard — the caller (fleet's armWriter) owns it on the concrete store", async () => {
    // The ownership-handoff flag: a fleet node boots with this so the runtime never registers a guard
    // on a sync node's SwitchableDocStore (where it would vanish on the promotion swapTo). With it set
    // and NO caller-installed guard, a keyed write records NO receipt and a resend RE-EXECUTES — the
    // direct proof that `create()` skipped its own registration. (Fleet's `armWriter` then installs the
    // guard on the concrete `pgStore`; that survival path is covered in
    // `ee/packages/fleet/test/receipts-guard-promotion.test.ts`.)
    const r = await makeRuntime({ externalReceiptsGuard: true });
    const first = await r.run("app:add", { body: "ext" }, dedup("cext", 1));
    expect(first.committed).toBe(true);
    expect(await r.store.getClientVerdict("", "cext", 1)).toBeNull(); // no guard ran → no receipt

    const second = await r.run("app:add", { body: "ext" }, dedup("cext", 1));
    expect(second.clientReplay).toBeUndefined(); // nothing to replay — it re-ran
    expect(second.committed).toBe(true);
    const list = await r.run("app:list", {});
    expect(list.value).toEqual(["ext", "ext"]); // TWO rows — re-executed, as expected with no barrier

    // Control: the DEFAULT (flag unset) runtime DOES register the guard — one row, a replay on resend.
    const g = await makeRuntime();
    await g.run("app:add", { body: "def" }, dedup("cdef", 1));
    const gSecond = await g.run("app:add", { body: "def" }, dedup("cdef", 1));
    expect(gSecond.clientReplay).toMatchObject({ verdict: "applied" });
    expect((await g.run("app:list", {})).value).toEqual(["def"]); // ONE row — the barrier held
  });

  it("concurrent duplicate resends land exactly ONE effect (the guard is the barrier; the loser replays)", async () => {
    const r = await makeRuntime();
    const [a, b] = await Promise.all([
      r.run("app:add", { body: "dup" }, dedup("c5", 1)),
      r.run("app:add", { body: "dup" }, dedup("c5", 1)),
    ]);
    const replays = [a, b].filter((x) => x.clientReplay !== undefined);
    const commits = [a, b].filter((x) => x.committed);
    expect(replays).toHaveLength(1); // the loser replay-acked
    expect(commits).toHaveLength(1); // exactly one fresh commit
    const list = await r.run("app:list", {});
    expect(list.value).toEqual(["dup"]); // ONE row
  });
});

describe("client-dedup — a replay skips the reactive fan-out (verdict Risk R7)", () => {
  it("a replayed mutation pushes NO Transition (nothing was written this call)", async () => {
    const r = await makeRuntime();
    const conn = r.connect("sess-1");
    const frames: ServerMessage[] = [];
    conn.onMessage((m) => frames.push(m));

    await conn.send({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "app:list", args: {} }], remove: [] });
    // Fresh dedup-keyed mutation → commits → fans out → a Transition lands.
    await conn.send({ type: "Mutation", requestId: "m1", udfPath: "app:add", args: { body: "live" }, clientId: "c6", seq: 1 });
    await new Promise((res) => setTimeout(res, 10));
    const transitionsAfterFirst = frames.filter((f) => f.type === "Transition").length;
    expect(transitionsAfterFirst).toBeGreaterThanOrEqual(2); // querySet + the commit fan-out

    frames.length = 0;
    // Resend the SAME (clientId, seq) → replay-ack, NO commit → NO Transition.
    await conn.send({ type: "Mutation", requestId: "m2", udfPath: "app:add", args: { body: "live" }, clientId: "c6", seq: 1 });
    await new Promise((res) => setTimeout(res, 10));
    const responses = frames.filter((f) => f.type === "MutationResponse");
    const transitions = frames.filter((f) => f.type === "Transition");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ requestId: "m2", success: true, replayed: true });
    expect(transitions).toHaveLength(0); // the replay fanned out nothing
  });
});
