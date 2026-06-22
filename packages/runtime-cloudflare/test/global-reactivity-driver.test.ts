/**
 * M2c Task 6: the `GlobalReactivityPoller` driver wired at `bootDurableObjectRuntime` — proves a DO
 * polls D1 for `.global()`-table changes and pushes reactive updates ONLY off the alarm/wake seam
 * (`doInstance.alarm()` -> `runtime.fireDueTimers()`, the SAME path a real DO's `alarm()` handler
 * takes off `ctx.storage.setAlarm`), never a free-running `setTimeout`/`setInterval` — mirrors
 * `host.test.ts`'s "fires due driver timers on the alarm" test, but with a composed driver that
 * actually has work to do.
 *
 * The cadence is driven deterministically throughout: an injected `now()` clock (`DurableObjectAppConfig.now`)
 * advanced by the test, plus explicit `doInstance.alarm()` calls — there is no real wall-clock sleep
 * anywhere in this file. `waitFor` (from `do-harness.ts`) settles on the driver's own re-arm decision
 * (`state.storage.peekAlarm()`), which only lands AFTER its async `tick()` (a `readVersions` D1 read,
 * then possibly `notifyWrites`) resolves — the same synchronization `host.test.ts` uses for its own
 * reactive-push assertions (`waitFor(() => wsA.sent.length > before)`), generalized to also prove the
 * "settles back to nothing armed" hibernation-safety property.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import type { LoadedProject } from "@stackbase/cli/project";
import type { D1Client, D1PreparedStatement } from "@stackbase/docstore-d1";
import { StackbaseDurableObject, type DurableObjectAppConfig } from "../src/index";
import { DEFAULT_GLOBAL_REACTIVITY_POLL_MS } from "../src/global-reactivity-driver";
import { FakeDoState, FakeDoWebSocket, waitFor } from "./do-harness";

/**
 * Fire the DO's alarm, first simulating the ONE thing `FakeDoStorage` doesn't reproduce about a
 * real Cloudflare DO's alarm: the platform auto-consumes/clears the alarm slot the instant it fires
 * (there is no separate "ack" step) — which is exactly why `runtime.ts`'s own `fireDueTimers`
 * unconditionally resets its `armedAt` mirror to `null` before doing anything else, and its `rearm()`
 * then skips a redundant `wakeHost.armWake(null)` when nothing needs to be armed (an optimization: a
 * real DO doesn't need telling twice that its own alarm already fired). `FakeDoStorage.alarm` is a
 * dumb value cell with no such auto-clear, so a test that wants to observe "did anything get
 * RE-armed after this fire" (as opposed to "was the pre-fire value overwritten by a later
 * `setAlarm`") must clear it itself first, or a stale pre-fire value can be mistaken for a fresh one.
 */
async function fireAlarm(state: FakeDoState, doInstance: StackbaseDurableObject): Promise<void> {
  state.storage.deleteAlarm();
  await doInstance.alarm();
}

/* --------------------- a fake D1Client over node:sqlite (fast lane, no I/O) --------------------- */
/**
 * Mirrors `packages/docstore-d1/test/support/sqlite-d1-client.ts`'s `sqliteD1Client()` almost
 * exactly, but backed by Node's built-in `node:sqlite` (already a dependency of this monorepo via
 * `@stackbase/docstore-do-sqlite`'s own test stand-in, `MemorySqlStorage`) instead of adding a new
 * `better-sqlite3` devDependency to this package just for one test fixture. `.all()` works fine even
 * on an INSERT/UPDATE under `node:sqlite` (returns `[]`), matching D1DocStore's own usage (every
 * non-`batch()` call goes through `.prepare().bind().all()`, never `.run()`).
 */
function nodeSqliteD1Client(): D1Client {
  const nodeRequire = createRequire(import.meta.url);
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): { changes: number } };
    };
  };
  const db = new DatabaseSync(":memory:");

  const stmt = (sql: string, bound: unknown[]): D1PreparedStatement => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...bound) as never }),
    run: async () => ({ changes: db.prepare(sql).run(...bound).changes }),
  });

  const client: D1Client = {
    prepare: (sql) => stmt(sql, []),
    exec: async (sql) => {
      db.exec(sql);
    },
    withSession: (_bookmark?: string) => ({ client, latestBookmark: () => undefined }),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        for (const s of statements) db.prepare(s.sql).run(...s.params);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return client;
}

/* ------------------------------- the fixture app ------------------------------ */

const schema = defineSchema({
  counters: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"], { unique: true }).global(),
});
const countersModule = {
  create: mutation<{ key: string; value: number }, string>({
    handler: (ctx, { key, value }) => ctx.db.insert("counters", { key, value }),
  }),
  getByKey: query<{ key: string }, unknown>({
    handler: async (ctx, { key }) => {
      const rows = await ctx.db.query("counters", "by_key").eq("key", key).collect();
      return (rows[0] as { key: string; value: number } | undefined) ?? null;
    },
  }),
};
const loaded: LoadedProject = { schema, modules: { counters: countersModule } };
const ADMIN_KEY = "test-admin-key";

function post(path: string, bodyObj: unknown): Request {
  return new Request(`https://do.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

function makeSocket(state: FakeDoState, connectionId: string): FakeDoWebSocket {
  const ws = new FakeDoWebSocket();
  ws.serializeAttachment({ connectionId, identity: null, subs: {} });
  state.seedSocket(ws);
  return ws;
}

describe("GlobalReactivityPoller wired at DO boot (M2c Task 6)", () => {
  it("polls D1 on the alarm seam and pushes an update after a global write, none for a no-op tick", async () => {
    let clock = 1_000_000;
    class TestDO extends StackbaseDurableObject {
      protected appConfig(): DurableObjectAppConfig {
        return { loaded, adminKey: ADMIN_KEY, d1: nodeSqliteD1Client(), now: () => clock };
      }
    }
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});

    // Subscribe to the global query BEFORE any write — its initial (empty) result is delivered
    // synchronously, over the normal subscribe path (never the poller).
    const ws = makeSocket(state, "connA");
    await doInstance.webSocketMessage(
      ws,
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "counters:getByKey", args: { key: "k1" } }], remove: [] }),
    );
    await waitFor(() => ws.framesOfType("Transition").length > 0);
    expect(ws.framesOfType("Transition").length).toBe(1);

    // The poller's bootstrap tick (force-armed at driver `start()`, ahead of the DO's own
    // eager-rehydrate-all-on-wake — see `global-reactivity-driver.ts`'s `armTimer` doc) establishes
    // ITS baseline version for `counters` (no writes yet) — first-seen, so it does NOT invalidate
    // (Task 5's documented semantic). `waitFor` on the re-arm settling is the sync point: `armTimer`
    // only runs (and only re-arms, since the subscriber is still live) AFTER `tick()` resolves.
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => state.storage.peekAlarm() === clock + DEFAULT_GLOBAL_REACTIVITY_POLL_MS);
    expect(ws.framesOfType("Transition").length).toBe(1); // unchanged — still just the initial subscribe

    // A write to the global table bumps D1's `_global_versions` counter for `counters`. This is NOT
    // visible via the local MVCC commit fan-out at all (a `.global()` write never touches the local
    // store — see `executor.ts`'s `globalStore.commitBatch` call, sequenced entirely outside the
    // local `runInTransaction`), so nothing pushes from the commit path itself.
    const beforeWrite = ws.sent.length;
    const runRes = await doInstance.fetch(post("/api/run", { path: "counters:create", args: { key: "k1", value: 1 } }));
    expect(runRes.status).toBe(200);
    expect(ws.sent.length).toBe(beforeWrite); // no reactive push from the commit path — confirms the gap the poller exists to close

    // Advance past the poller's next cadence and fire the alarm — THIS is what notices the version
    // bump and pushes the update. `runtime.fireDueTimers()` is the entire firing mechanism; no
    // `setInterval`/`setTimeout` is involved anywhere in the DO path.
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => ws.sent.length > beforeWrite);
    const pushed = ws.framesOfType("Transition");
    expect(pushed.length).toBe(2);
    expect(JSON.stringify(pushed[1])).toContain("k1");

    // A further tick with no intervening write does not push again.
    const afterFirstUpdate = ws.sent.length;
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => state.storage.peekAlarm() === clock + DEFAULT_GLOBAL_REACTIVITY_POLL_MS);
    expect(ws.sent.length).toBe(afterFirstUpdate);

    // A second write (to a different key) bumps the table's version again — table-level
    // invalidation (`.global()` reads have no range-precise read-set, per Task 5's own header doc)
    // re-runs and pushes EVERY subscription reading `counters`, including this one, even though its
    // own row (`k1`) is untouched by the write.
    await doInstance.fetch(post("/api/run", { path: "counters:create", args: { key: "k2", value: 2 } }));
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => ws.framesOfType("Transition").length > pushed.length);
    expect(ws.framesOfType("Transition").length).toBe(3);
  });

  it("with no global subscribers, the poller's bootstrap tick disarms itself (DO can hibernate)", async () => {
    let clock = 1_000_000;
    class TestDO extends StackbaseDurableObject {
      protected appConfig(): DurableObjectAppConfig {
        return { loaded, adminKey: ADMIN_KEY, d1: nodeSqliteD1Client(), now: () => clock };
      }
    }
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});
    await doInstance.fetch(new Request("https://do.test/api/health")); // force boot, no subscribers ever

    // The bootstrap tick is force-armed unconditionally at driver `start()` (it must be, to survive
    // the eager-rehydrate-on-wake ordering on a REAL hibernation wake — see the driver's doc) — so
    // right after boot, something IS armed, even though zero global tables are subscribed yet.
    expect(state.storage.peekAlarm()).not.toBeNull();

    // Firing it: `subscribedGlobalTables()` is empty, so the poller's `tick()` doesn't even call
    // `readVersions` (Task 5's own no-op-when-unsubscribed guarantee), and the driver's post-tick
    // `armTimer()` does NOT re-arm — settling back to nothing armed, so the DO is free to hibernate.
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => state.storage.peekAlarm() === null);
    expect(state.storage.peekAlarm()).toBeNull();
  });

  it("arms itself on a late global subscribe on a live (never-hibernating) DO instance — busy-DO late-subscribe fix", async () => {
    let clock = 1_000_000;
    class TestDO extends StackbaseDurableObject {
      protected appConfig(): DurableObjectAppConfig {
        return { loaded, adminKey: ADMIN_KEY, d1: nodeSqliteD1Client(), now: () => clock };
      }
    }
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});

    // Boot with NO subscribers at all — the bootstrap force-arm (driver `start()`) still arms one
    // timer, same as the "disarms itself" test above.
    await doInstance.fetch(new Request("https://do.test/api/health"));
    expect(state.storage.peekAlarm()).not.toBeNull();

    // Fire it: zero global subscribers -> the driver's post-tick `armTimer()` does not re-arm,
    // settling back to nothing armed. On a real BUSY DO (open local-table subscriptions/mutations
    // keeping it from ever hibernating), nothing else would EVER re-arm this timer — that's the gap
    // the fix under test closes.
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => state.storage.peekAlarm() === null);
    expect(state.storage.peekAlarm()).toBeNull();

    // NOW subscribe on the SAME live DO instance via `ModifyQuerySet` — no reconstruction, no
    // rehydrate, no bootstrap force-arm. Before the fix, nothing would ever re-arm the poller from
    // here, and this subscription's `.global()` read would be permanently non-reactive.
    const ws = makeSocket(state, "connA");
    await doInstance.webSocketMessage(
      ws,
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "counters:getByKey", args: { key: "k1" } }], remove: [] }),
    );
    await waitFor(() => ws.framesOfType("Transition").length > 0);
    expect(ws.framesOfType("Transition").length).toBe(1); // initial (empty) result, delivered synchronously

    // The arm-on-subscribe hook must have armed a fresh wake — this is the direct proof of the fix.
    // Before it, `peekAlarm()` would still be `null` here (no timer, nothing scheduled).
    expect(state.storage.peekAlarm()).toBe(clock + DEFAULT_GLOBAL_REACTIVITY_POLL_MS);

    // This freshly-armed wake is the poller's FIRST-EVER tick with a non-empty `subscribedGlobalTables()`
    // (every earlier tick, before the subscribe, no-op'd on zero subscribers) — so it establishes the
    // baseline version for `counters` rather than invalidating anything (Task 5's documented
    // first-seen semantics; see `global-reactivity-poller.ts`'s header doc). Fire it before writing,
    // exactly like the "polls D1 on the alarm seam" test above does for its own bootstrap tick.
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => state.storage.peekAlarm() === clock + DEFAULT_GLOBAL_REACTIVITY_POLL_MS);
    expect(ws.framesOfType("Transition").length).toBe(1); // unchanged — baseline tick, no push

    // A write to the global table, then firing the NEXT alarm, must reactively push — this would NOT
    // happen before the fix (the poller stayed disarmed forever after the first 0-subscriber tick, so
    // this subscription's `.global()` read was permanently non-reactive).
    const beforeWrite = ws.sent.length;
    const runRes = await doInstance.fetch(post("/api/run", { path: "counters:create", args: { key: "k1", value: 1 } }));
    expect(runRes.status).toBe(200);
    expect(ws.sent.length).toBe(beforeWrite); // no push from the commit path itself (global writes never touch local MVCC)

    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => ws.sent.length > beforeWrite);
    const pushed = ws.framesOfType("Transition");
    expect(pushed.length).toBe(2);
    expect(JSON.stringify(pushed[1])).toContain("k1");
  });

  it("the poll cadence is a fixed ~intervalMs re-arm, decoupled from a host's backstopMs floor", async () => {
    let clock = 1_000_000;
    class TestDO extends StackbaseDurableObject {
      protected appConfig(): DurableObjectAppConfig {
        return {
          loaded,
          adminKey: ADMIN_KEY,
          d1: nodeSqliteD1Client(),
          now: () => clock,
          // The real Cloudflare host wires exactly this floor for its OTHER pure-backstop drivers
          // (the storage reaper) — see `DurableObjectAppConfig.backstopMs`'s doc comment. Global
          // reactivity must NOT ride it (Fix 2): a 15-minute-stale `.global()` subscription would
          // otherwise be an acceptable-looking but silently broken deploy.
          backstopMs: (d: number) => Math.max(d, 900_000),
        };
      }
    }
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});

    const ws = makeSocket(state, "connA");
    await doInstance.webSocketMessage(
      ws,
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "counters:getByKey", args: { key: "k1" } }], remove: [] }),
    );
    await waitFor(() => ws.framesOfType("Transition").length > 0);

    // Fire the bootstrap tick (establishes the baseline, doesn't invalidate — Task 5 semantics) and
    // assert the driver's own post-tick re-arm — the steady-state cadence — is exactly
    // `clock + intervalMs`. Before Fix 2 this would instead be `clock + 900_000` (the backstop
    // floor), and this assertion would time out waiting for a value that never arrives.
    clock += DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
    await fireAlarm(state, doInstance);
    await waitFor(() => state.storage.peekAlarm() === clock + DEFAULT_GLOBAL_REACTIVITY_POLL_MS);
    expect(state.storage.peekAlarm()).toBe(clock + DEFAULT_GLOBAL_REACTIVITY_POLL_MS);
    expect(state.storage.peekAlarm()).not.toBe(clock + 900_000);
  });

  it("additive: no `d1` binding composes no poller driver (unchanged from before M2c Task 6)", async () => {
    class TestDO extends StackbaseDurableObject {
      protected appConfig(): DurableObjectAppConfig {
        // No `d1` — `bootDurableObjectRuntime`'s `globalStore` stays `undefined`, so `boot.ts`'s
        // `drivers` array composes nothing extra (this schema also declares no `.global()` table, so
        // boot doesn't fail-fast either).
        const noGlobalSchema = defineSchema({ items: defineTable({ name: v.string() }).index("by_creation", []) });
        return { loaded: { schema: noGlobalSchema, modules: {} }, adminKey: ADMIN_KEY };
      }
    }
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});
    await doInstance.fetch(new Request("https://do.test/api/health"));
    // No driver ever arms anything — the alarm fires and finds nothing due, exactly like
    // `host.test.ts`'s "fires due driver timers on the alarm" case with zero composed drivers.
    expect(state.storage.peekAlarm()).toBeNull();
    await expect(doInstance.alarm()).resolves.toBeUndefined();
  });
});
