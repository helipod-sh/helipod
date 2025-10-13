/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Shards B2b, Task 2: `WriteForwarder`'s per-shard forwarding + the single-hop guard.
 *
 * `writerUrlFor(shardId)` (renamed from the shipped single-shard `writerUrl()`) reads THAT shard's
 * `shard_leases` row, caches it per shard, and refreshes + retries once on a failed POST — the
 * shipped single-shard pattern (`forwarder-ryow.test.ts`'s transport-failure retry), now keyed per
 * shard so different shards can be owned by different nodes. `isLocalWriter(shardId)` is a live view
 * of `LeaseManager.currentEpoch(shardId)` — the SAME held-set source of truth `relinquish()` uses.
 *
 * A stub `PgClient` (not PGlite) backs the `LeaseManager`, keyed by shard id, so different shards'
 * rows can be programmed independently and mutated mid-test (simulating a rebalance/failover moving
 * a shard to a new owner) — mirrors `forwarder-ryow.test.ts`'s stubbing style; that file covers the
 * RYOW wait itself and stays untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PgClient, PgQuerier, PgRow, PgValue } from "@stackbase/docstore-postgres";
import { NOT_SHARD_OWNER_CODE } from "@stackbase/errors";
import { LeaseManager } from "../src/lease";
import { WriteForwarder } from "../src/forwarder";

interface StubRow {
  epoch: bigint;
  writer_url: string;
}

/** Stub `PgClient` whose `shard_leases` row per shard is independently programmable/mutable — lets
 *  tests simulate different shards owned by different writer URLs, and move a shard to a new URL
 *  mid-test (as if a rebalance/failover happened) without standing up real Postgres. Every
 *  `LeaseManager.read(shardId)` call this class serves is `WHERE shard_id = $1` — `params[0]`. */
class StubPgClient implements PgClient {
  constructor(readonly rows: Map<string, StubRow>) {}
  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    // `LeaseManager.tryAcquire`'s upsert (used only by the `isLocalWriter` test below) — simulate the
    // `ON CONFLICT ... epoch = epoch + 1` upsert well enough to exercise `currentEpoch`/`forgetShard`.
    if (text.includes("INSERT INTO shard_leases")) {
      const [shardId, writerUrl] = params as readonly [string, string, string | null];
      const existing = this.rows.get(shardId);
      const epoch = existing ? existing.epoch + 1n : 1n;
      this.rows.set(shardId, { epoch, writer_url: writerUrl });
      return [{ epoch, writer_url: writerUrl }];
    }
    // `LeaseManager.read(shardId)` — `WHERE shard_id = $1`.
    const shardId = params?.[0] as string | undefined;
    const row = shardId !== undefined ? this.rows.get(shardId) : undefined;
    return row ? [{ epoch: row.epoch, writer_url: row.writer_url }] : [];
  }
  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async acquireWriterLock(): Promise<void> {}
  async tryAcquireWriterLock(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function make(rows: Map<string, StubRow>): { lease: LeaseManager; client: StubPgClient; forwarder: WriteForwarder } {
  const client = new StubPgClient(rows);
  const lease = new LeaseManager(client, { advertiseUrl: "http://self:4001" });
  const forwarder = new WriteForwarder(lease, { adminKey: "test-admin-key", selfUrl: "http://self:4001" });
  return { lease, client, forwarder };
}

describe("WriteForwarder — per-shard writerUrlFor cache + refresh (Task 2, test a)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads THAT shard's row, caches it, is scoped per shard, and refreshes + retries once on a failed POST", async () => {
    const rows = new Map<string, StubRow>([
      ["s3", { epoch: 1n, writer_url: "http://s3-owner-old:4000" }],
      ["default", { epoch: 1n, writer_url: "http://default-owner:4000" }],
    ]);
    const { client, forwarder } = make(rows);
    const querySpy = vi.spyOn(client, "query");

    // The old s3 owner starts up (serves normally); it only goes stale/dead once the test explicitly
    // simulates a rebalance below — otherwise the FIRST (successful) call would spuriously "fail".
    let s3OldIsDead = false;
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      if (s3OldIsDead && url.startsWith("http://s3-owner-old")) throw new TypeError("fetch failed");
      return jsonResponse({ value: `ok-${url}`, commitTs: "5" });
    }) as unknown as typeof fetch;

    // First call for s3: a genuine cache miss — reads s3's OWN row (not default's).
    const r1 = await forwarder.forward("mutation", "notes:add", {}, null, "s3");
    expect(r1.value).toBe("ok-http://s3-owner-old:4000/_fleet/run");
    expect(querySpy).toHaveBeenCalledTimes(1);

    // Second call for s3: cache hit — no new lease read, same URL reused.
    querySpy.mockClear();
    requestedUrls.length = 0;
    const r2 = await forwarder.forward("mutation", "notes:add", {}, null, "s3");
    expect(r2.value).toBe("ok-http://s3-owner-old:4000/_fleet/run");
    expect(querySpy).not.toHaveBeenCalled();

    // A call for a DIFFERENT shard ("default") is scoped independently — its own cache miss reads
    // default's row, never s3's cached URL.
    querySpy.mockClear();
    const rDefault = await forwarder.forward("mutation", "notes:add", {}, null, "default");
    expect(rDefault.value).toBe("ok-http://default-owner:4000/_fleet/run");
    expect(querySpy).toHaveBeenCalledTimes(1);

    // Now the shard moves (a rebalance/failover): s3's row is updated to a NEW owner, and the old
    // owner stops answering, but the forwarder's cache still holds the STALE url until it fails a POST.
    rows.set("s3", { epoch: 2n, writer_url: "http://s3-owner-new:4000" });
    s3OldIsDead = true;
    querySpy.mockClear();
    requestedUrls.length = 0;
    const r3 = await forwarder.forward("mutation", "notes:add", {}, null, "s3");
    // First attempt hits the STALE cached URL and fails (transport); the forwarder refreshes
    // (re-reads s3's row — now the new owner) and retries ONCE, which succeeds.
    expect(requestedUrls).toEqual([
      "http://s3-owner-old:4000/_fleet/run",
      "http://s3-owner-new:4000/_fleet/run",
    ]);
    expect(r3.value).toBe("ok-http://s3-owner-new:4000/_fleet/run");
    expect(querySpy).toHaveBeenCalledTimes(1); // exactly the refresh read, not a second stale hit

    // The cache now holds the NEW url — a subsequent call goes straight there, no failure/retry.
    querySpy.mockClear();
    requestedUrls.length = 0;
    const r4 = await forwarder.forward("mutation", "notes:add", {}, null, "s3");
    expect(requestedUrls).toEqual(["http://s3-owner-new:4000/_fleet/run"]);
    expect(r4.value).toBe("ok-http://s3-owner-new:4000/_fleet/run");
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("isLocalWriter(shardId) is a live per-shard view of the lease's held-epoch map", async () => {
    const rows = new Map<string, StubRow>();
    const { lease, forwarder } = make(rows);
    expect(forwarder.isLocalWriter("s3")).toBe(false);
    expect(forwarder.isLocalWriter("default")).toBe(false);

    await lease.tryAcquire("s3", 3);
    expect(forwarder.isLocalWriter("s3")).toBe(true);
    // Acquiring s3 doesn't make the node the owner of any OTHER shard.
    expect(forwarder.isLocalWriter("default")).toBe(false);

    lease.forgetShard("s3");
    expect(forwarder.isLocalWriter("s3")).toBe(false);
  });
});

describe("WriteForwarder — outbound not-the-owner handling (Task 2, test c)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function notOwnerResponse(): Response {
    return jsonResponse(
      {
        error: "fleet: this node is not the owner of shard 's3'",
        code: NOT_SHARD_OWNER_CODE,
        errorJson: {
          name: "NotShardOwnerError",
          code: NOT_SHARD_OWNER_CODE,
          message: "fleet: this node is not the owner of shard 's3'",
          httpStatus: 409,
          retryable: true,
        },
      },
      409,
    );
  }

  it("refreshes the shard's cache and re-routes ONCE on a not-the-owner response, then surfaces the retry's outcome", async () => {
    const rows = new Map<string, StubRow>([["s3", { epoch: 1n, writer_url: "http://stale-node:4000" }]]);
    const { client, forwarder } = make(rows);

    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      if (url.startsWith("http://stale-node")) return notOwnerResponse();
      return jsonResponse({ value: "ran-on-the-real-owner", commitTs: "9" });
    }) as unknown as typeof fetch;

    // The row must still read STALE for the forwarder's FIRST (cache-miss) read — that's what sends
    // the first hop to the node that answers "not me" — but has moved on by the time the RETRY's
    // refresh re-reads it (a rebalance/failover that happened in between). Rewriting the row from
    // inside the second `query()` call reproduces exactly that ordering without a real clock/lease.
    const originalQuery = client.query.bind(client);
    let reads = 0;
    vi.spyOn(client, "query").mockImplementation(async (text, params) => {
      reads += 1;
      if (reads === 2) rows.set("s3", { epoch: 2n, writer_url: "http://real-owner:4000" });
      return originalQuery(text, params);
    });

    const result = await forwarder.forward("mutation", "notes:add", {}, null, "s3");

    expect(requestedUrls).toEqual(["http://stale-node:4000/_fleet/run", "http://real-owner:4000/_fleet/run"]);
    expect(result.value).toBe("ran-on-the-real-owner");
  });

  it("a not-the-owner response on the retry too is surfaced — never a third hop", async () => {
    const rows = new Map<string, StubRow>([["s3", { epoch: 1n, writer_url: "http://node-a:4000" }]]);
    const { forwarder } = make(rows);

    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      return notOwnerResponse(); // every node says "not me" — a pathological/racy fleet state
    }) as unknown as typeof fetch;

    await expect(forwarder.forward("mutation", "notes:add", {}, null, "s3")).rejects.toMatchObject({
      code: NOT_SHARD_OWNER_CODE,
    });
    // Exactly two hops (original + the one retry) — never chases a moving target further.
    expect(requestedUrls).toHaveLength(2);
  });

  it("a genuine OCC-style typed error from the owner is NOT retried — propagated unchanged", async () => {
    const rows = new Map<string, StubRow>([["s3", { epoch: 1n, writer_url: "http://owner:4000" }]]);
    const { forwarder } = make(rows);

    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: "commit fenced",
          code: "OCC_CONFLICT",
          errorJson: {
            name: "OccConflictError",
            code: "OCC_CONFLICT",
            message: "commit fenced",
            httpStatus: 409,
            retryable: true,
          },
        },
        409,
      ),
    ) as unknown as typeof fetch;
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await expect(forwarder.forward("mutation", "notes:add", {}, null, "s3")).rejects.toMatchObject({
      code: "OCC_CONFLICT",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry — the owner answered definitively
  });
});

describe("WriteForwarder — effectively-once forwarding: one idempotencyKey per logical write (Fleet B3, Task 3)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function parseBody(call: unknown[]): { idempotencyKey?: string } {
    const init = call[1] as { body?: string } | undefined;
    return init?.body ? (JSON.parse(init.body) as { idempotencyKey?: string }) : {};
  }

  it("mints ONE UUID and sends the SAME idempotencyKey on both the failed first POST and the retry", async () => {
    const rows = new Map<string, StubRow>([["s3", { epoch: 1n, writer_url: "http://stale-node:4000" }]]);
    const { forwarder } = make(rows);

    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 1) throw new TypeError("fetch failed"); // transport failure — triggers retry-once
      return jsonResponse({ value: "ok", commitTs: "5" });
    }) as unknown as typeof fetch;

    await forwarder.forward("mutation", "notes:add", { title: "x" }, null, "s3");

    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const key1 = parseBody(fetchSpy.mock.calls[0]!).idempotencyKey;
    const key2 = parseBody(fetchSpy.mock.calls[1]!).idempotencyKey;
    expect(typeof key1).toBe("string");
    expect(key1).toBeTruthy();
    expect(key2).toBe(key1); // reused verbatim across the retry — NOT a fresh UUID per hop
  });

  it("two SEPARATE forward() calls (two distinct logical writes) mint two DIFFERENT keys", async () => {
    const rows = new Map<string, StubRow>([["s3", { epoch: 1n, writer_url: "http://owner:4000" }]]);
    const { forwarder } = make(rows);
    globalThis.fetch = vi.fn(async () => jsonResponse({ value: "ok", commitTs: "5" })) as unknown as typeof fetch;

    await forwarder.forward("mutation", "notes:add", { title: "a" }, null, "s3");
    await forwarder.forward("mutation", "notes:add", { title: "b" }, null, "s3");

    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const key1 = parseBody(fetchSpy.mock.calls[0]!).idempotencyKey;
    const key2 = parseBody(fetchSpy.mock.calls[1]!).idempotencyKey;
    expect(key1).toBeTruthy();
    expect(key2).toBeTruthy();
    expect(key1).not.toBe(key2);
  });
});
