/**
 * Fleet B3, Task 3 — effectively-once forwarding: `/_fleet/run`'s SELECT-first replay, post-run
 * value recording, and the catch-unique_violation-then-replay path (`handleHttpRequest`,
 * `packages/cli/src/http-handler.ts`).
 *
 * The routing/shape tests below use a lightweight in-memory fake for `FleetHandles.idempotencyLookup`/
 * `idempotencyRecordValue` — they exercise the HANDLER's control flow (SELECT-first skip-execution,
 * catch-and-replay, the app-schema-vs-fleet-table 23505 distinction), not the real Postgres guard.
 *
 * The final `describe` block ("the concurrent-duplicate race") is a REAL integration test: a real
 * `PostgresDocStore` over PGlite + `LeaseManager` + `installCommitGuard` (from `@stackbase/fleet`,
 * already a devDependency here) wired into a real `FleetHandles`, proving the actual end-to-end
 * scenario the design doc requires — two concurrent forwards of the SAME idempotencyKey commit
 * exactly one row, with the loser's response a replay of the winner's commitTs, not a 500.
 *
 * `fleet-run-route.test.ts` covers the pre-existing (non-idempotency) `/_fleet/run` behavior and is
 * left untouched — these are additive tests.
 */
import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation } from "@stackbase/executor";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { LeaseManager, installCommitGuard, type IdempotencyReplay } from "@stackbase/fleet";
import { CommitGuardRejection } from "@stackbase/errors";
import type { JSONValue } from "@stackbase/values";
import { handleHttpRequest, type FleetHandles } from "../src/http-handler";
import { PgliteClient } from "./pglite-client";

/** In-memory fake for the two idempotency seams — enough to drive the HANDLER's control flow
 *  without a real Postgres guard (see the file doc comment). */
class FakeIdempotencyStore {
  private rows = new Map<string, { commitTs: bigint; hasValue: boolean; value: JSONValue | null; oversized: boolean }>();

  seed(key: string, row: { commitTs: bigint; hasValue: boolean; value?: JSONValue | null; oversized?: boolean }): void {
    this.rows.set(key, { hasValue: row.hasValue, value: row.value ?? null, oversized: row.oversized ?? false, commitTs: row.commitTs });
  }

  lookup = vi.fn(async (key: string): Promise<IdempotencyReplay | null> => {
    const row = this.rows.get(key);
    return row ? { ...row } : null;
  });

  recordValue = vi.fn(async (key: string, value: JSONValue): Promise<void> => {
    const existing = this.rows.get(key);
    if (!existing) return;
    existing.hasValue = true;
    existing.value = value;
  });
}

function baseFleetHandles(store: FakeIdempotencyStore, overrides: Partial<FleetHandles> = {}): FleetHandles {
  return {
    role: () => "writer",
    writerUrl: async () => "http://self:4000",
    onPromoted: () => {},
    isLocalWriter: () => true,
    idempotencyLookup: store.lookup,
    idempotencyRecordValue: store.recordValue,
    stop: async () => {},
    ...overrides,
  };
}

async function setup(handlerSpy?: (a: { title: string }) => void) {
  const dbStore = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store: dbStore,
    catalog,
    logSink,
    modules: {
      "notes:add": mutation(async (ctx, a: { title: string }) => {
        handlerSpy?.(a);
        return ctx.db.insert("notes", a);
      }),
    },
  });
  const info = { functions: ["notes:add"], tables: ["notes"] };
  return { runtime, admin: { api: undefined as never, key: "k" }, info };
}

function req(body: unknown) {
  return {
    method: "POST",
    path: "/_fleet/run",
    body: JSON.stringify(body),
    authorization: "Bearer k",
  };
}

describe("/_fleet/run — SELECT-first replay (Fleet B3, Task 3)", () => {
  it("a duplicate idempotencyKey hit replays WITHOUT executing the mutation handler", async () => {
    const handlerSpy = vi.fn();
    const { runtime, admin, info } = await setup(handlerSpy);
    const store = new FakeIdempotencyStore();
    store.seed("dup-1", { commitTs: 42n, hasValue: true, value: "cached-id" });
    const fleet = baseFleetHandles(store);

    const res = await handleHttpRequest(
      runtime,
      req({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation", idempotencyKey: "dup-1" }),
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { replayed: true; commitTs: string; value: string };
    expect(body.replayed).toBe(true);
    expect(body.commitTs).toBe("42");
    expect(body.value).toBe("cached-id");
    expect(handlerSpy).not.toHaveBeenCalled(); // the handler body never ran
    expect(store.recordValue).not.toHaveBeenCalled(); // no run → nothing to record
  });

  it("a crash-window / oversized row (hasValue:false) replays with valueMissing:true, never a bare value", async () => {
    const { runtime, admin, info } = await setup();
    const store = new FakeIdempotencyStore();
    store.seed("crash-1", { commitTs: 7n, hasValue: false });
    const fleet = baseFleetHandles(store);

    const res = await handleHttpRequest(
      runtime,
      req({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation", idempotencyKey: "crash-1" }),
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { replayed: true; commitTs: string; valueMissing?: true; value?: unknown };
    expect(body.replayed).toBe(true);
    expect(body.commitTs).toBe("7");
    expect(body.valueMissing).toBe(true);
    expect(body.value).toBeUndefined();
  });

  it("a miss runs the mutation, then best-effort records its value onto the idempotency row", async () => {
    const { runtime, admin, info } = await setup();
    const store = new FakeIdempotencyStore();
    store.seed("miss-1", { commitTs: 0n, hasValue: false }); // pre-committed by the (simulated) guard, value not yet recorded
    const fleet = baseFleetHandles(store);

    const res = await handleHttpRequest(
      runtime,
      req({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation", idempotencyKey: "already-committed-but-this-key-is-fresh" }),
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { value: string; commitTs: string };
    expect(typeof body.value).toBe("string"); // the fresh document id
    expect(store.recordValue).toHaveBeenCalledTimes(1);
    expect(store.recordValue.mock.calls[0]![0]).toBe("already-committed-but-this-key-is-fresh");
    expect(store.recordValue.mock.calls[0]![1]).toBe(body.value);
  });

  it("no idempotencyKey in the request body skips the whole idempotency path — lookup/record never called", async () => {
    const { runtime, admin, info } = await setup();
    const store = new FakeIdempotencyStore();
    const fleet = baseFleetHandles(store);

    const res = await handleHttpRequest(
      runtime,
      req({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation" }),
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200);
    expect(store.lookup).not.toHaveBeenCalled();
    expect(store.recordValue).not.toHaveBeenCalled();
  });

  it("an older/stub FleetHandles with no idempotency methods is byte-identical (no crash, plain run)", async () => {
    const { runtime, admin, info } = await setup();
    const fleet: FleetHandles = {
      role: () => "writer",
      writerUrl: async () => "http://self:4000",
      onPromoted: () => {},
      stop: async () => {},
    };

    const res = await handleHttpRequest(
      runtime,
      req({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation", idempotencyKey: "whatever" }),
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { value: unknown };
    expect(typeof body.value).toBe("string");
  });
});

describe("/_fleet/run — catch unique_violation-shaped commit failure → re-SELECT → replay (Fleet B3, Task 3)", () => {
  it("a synthetic fleet-idempotency CommitGuardRejection during the run is caught and replayed, NOT surfaced as an error", async () => {
    // Receipted Outbox (decision 2): the real fleet guard now converts the raw 23505 into a typed
    // CommitGuardRejection(FLEET_IDEMPOTENCY_CONFLICT); the handler detects it via `instanceof`.
    const guardErr = new CommitGuardRejection(0, "FLEET_IDEMPOTENCY_CONFLICT", "key=race-key");
    const handlerSpy = vi.fn((_a: { title: string }) => {
      throw guardErr;
    });
    const dbStore = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog();
    catalog.addTable("notes", 10001);
    const runtime = await EmbeddedRuntime.create({
      store: dbStore,
      catalog,
      modules: {
        "notes:add": mutation(async (_ctx, a: { title: string }) => {
          handlerSpy(a);
          return "never";
        }),
      },
    });
    const info = { functions: ["notes:add"], tables: ["notes"] };
    const admin = { api: undefined as never, key: "k" };

    const store = new FakeIdempotencyStore();
    // Miss on the first lookup (SELECT-first); a hit on the SECOND (the post-catch re-select) —
    // simulating the winner's row having landed between the two.
    store.lookup = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ commitTs: 99n, hasValue: true, value: "winner-value", oversized: false });
    const fleet = baseFleetHandles(store);

    const res = await handleHttpRequest(
      runtime,
      req({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation", idempotencyKey: "race-key" }),
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200); // NOT a 500
    const body = JSON.parse(res.body) as { replayed: true; commitTs: string; value: string };
    expect(body.replayed).toBe(true);
    expect(body.commitTs).toBe("99");
    expect(body.value).toBe("winner-value");
    expect(store.lookup).toHaveBeenCalledTimes(2); // SELECT-first miss, then the post-catch re-select
  });

  it("a 23505 on an APP-schema constraint (NOT fleet_idempotency) is never treated as a replay — surfaces as a real error", async () => {
    const appErr = Object.assign(new Error('duplicate key value violates unique constraint "notes_title_key"'), {
      code: "23505",
      table: "notes",
      constraint: "notes_title_key",
    });
    const dbStore = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog();
    catalog.addTable("notes", 10001);
    const runtime = await EmbeddedRuntime.create({
      store: dbStore,
      catalog,
      modules: {
        "notes:add": mutation(async () => {
          throw appErr;
        }),
      },
    });
    const info = { functions: ["notes:add"], tables: ["notes"] };
    const admin = { api: undefined as never, key: "k" };

    const store = new FakeIdempotencyStore();
    const fleet = baseFleetHandles(store);

    const res = await handleHttpRequest(
      runtime,
      req({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation", idempotencyKey: "not-a-race" }),
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).not.toBe(200); // a real failure, not silently replayed
    expect(store.lookup).toHaveBeenCalledTimes(1); // only the SELECT-first — never re-selected
  });
});

describe("/_fleet/run — the concurrent-duplicate race, end-to-end through a REAL Postgres guard (Fleet B3, Task 3)", () => {
  it(
    "simulates the loser: the winner's write commits for real (real fleet_idempotency INSERT); the " +
      "loser is forced past its own SELECT-first (as if it had raced the winner's SELECT-miss), so its " +
      "OWN guard INSERT collides with the real committed row — the whole loser commit aborts, the " +
      "handler catches it and replays the winner's commitTs, and the app table ends up with ONE row",
    async () => {
      const client = new PgliteClient();
      const pgStore = new PostgresDocStore(client);
      await pgStore.setupSchema();
      const lease = new LeaseManager(client, { advertiseUrl: "http://self:4000" });
      await lease.setup();
      await lease.tryAcquire(); // epoch 1 on the default shard — required for the guard to accept commits
      installCommitGuard(pgStore, lease, () => {});

      const catalog = new SimpleIndexCatalog();
      catalog.addTable("notes", 10001);
      const runtime = await EmbeddedRuntime.create({
        store: pgStore,
        catalog,
        modules: {
          "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)),
        },
      });
      const info = { functions: ["notes:add"], tables: ["notes"] };
      const admin = { api: undefined as never, key: "k" };

      // `forceMissOnce`: the ONE seam standing in for genuine cross-request concurrency — a single
      // PGlite instance is one in-process session (real cross-connection concurrency is proven at
      // the real-container Docker fleet E2E, not here), so this deterministically reproduces "the
      // loser's SELECT-first also missed" without corrupting PGlite's single session with two
      // interleaved BEGIN/COMMIT sequences. Everything downstream of the SELECT-first — the run
      // attempt, the REAL guard's atomic INSERT, the REAL unique_violation, the catch, and the
      // REAL re-select — is production code, untouched.
      let forceMissOnce = false;
      const fleet: FleetHandles = {
        role: () => "writer",
        writerUrl: async () => "http://self:4000",
        onPromoted: () => {},
        isLocalWriter: () => true,
        idempotencyLookup: async (key) => {
          if (forceMissOnce) {
            forceMissOnce = false;
            return null;
          }
          return lease.lookupIdempotency(key);
        },
        idempotencyRecordValue: (key, value) => lease.recordIdempotencyValue(key, value),
        stop: async () => {},
      };

      // The winner: a genuine miss → runs for real → commits → the guard's real INSERT lands.
      const r1 = await handleHttpRequest(
        runtime,
        req({ path: "notes:add", args: { title: "winner" }, identity: null, kind: "mutation", idempotencyKey: "race-key" }),
        info,
        admin,
        undefined,
        undefined,
        fleet,
      );
      expect(r1.status).toBe(200);
      const b1 = JSON.parse(r1.body) as { value: string; commitTs: string; replayed?: true };
      expect(b1.replayed).toBeUndefined(); // fresh, not a replay

      // The loser: forced past its own SELECT-first (simulating it having raced the winner's
      // SELECT-miss); it runs for real, and its own guard INSERT collides with the winner's
      // already-committed row — a REAL 23505 on fleet_idempotency, caught by the handler.
      forceMissOnce = true;
      const r2 = await handleHttpRequest(
        runtime,
        req({ path: "notes:add", args: { title: "loser" }, identity: null, kind: "mutation", idempotencyKey: "race-key" }),
        info,
        admin,
        undefined,
        undefined,
        fleet,
      );
      expect(r2.status).toBe(200); // NOT a 500 — the caught-and-replayed shape
      const b2 = JSON.parse(r2.body) as { value: string; commitTs: string; replayed?: true };
      expect(b2.replayed).toBe(true);
      expect(b2.commitTs).toBe(b1.commitTs); // the WINNER's commitTs, not a fresh one
      expect(b2.value).toBe(b1.value); // the WINNER's value ("winner"'s doc id, not "loser"'s)

      // Exactly ONE row landed in the app table — the loser's own document insert rolled back with
      // its whole aborted transaction. Counted directly off the `documents` log (the only table
      // besides `fleet_idempotency` this test writes to) rather than through a registered index.
      const docsCount = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
      expect(Number(docsCount[0]!.n)).toBe(1);

      await client.close();
    },
  );
});
