import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaseManager } from "../src/lease";
import { PgliteClient } from "./pglite-client";

// Real advisory-lock CONTENTION (a second writer failing to acquire while the first holds it) is
// NOT covered here — PgliteClient is a single in-process connection where tryAcquireWriterLock()
// is always true (see test/pglite-client.ts). That path is covered only by the Task 7 E2E against
// real Postgres with two independent connections.

describe("LeaseManager", () => {
  let client: PgliteClient;

  beforeEach(() => {
    client = new PgliteClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it("setup() creates the fleet_lease table", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    const rows = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'fleet_lease'",
    );
    expect(rows.length).toBe(1);
  });

  it("tryAcquire() returns epoch 1 on first call, epoch 2 on second", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();

    const first = await mgr.tryAcquire();
    expect(first).toEqual({ epoch: 1n, writerUrl: "http://node-a:4000" });

    const second = await mgr.tryAcquire();
    expect(second).toEqual({ epoch: 2n, writerUrl: "http://node-a:4000" });
  });

  it("read() returns the latest lease row", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();

    expect(await mgr.read()).toBeNull();

    await mgr.tryAcquire();
    expect(await mgr.read()).toEqual({ epoch: 1n, writerUrl: "http://node-a:4000" });

    await mgr.tryAcquire();
    expect(await mgr.read()).toEqual({ epoch: 2n, writerUrl: "http://node-a:4000" });
  });

  it("acquireLoop() fires onAcquired once then stop() halts further retries", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000", retryMs: 10 });
      await mgr.setup();

      const onAcquired = vi.fn();
      mgr.acquireLoop(onAcquired);

      // Let the loop's first (immediate or timer-driven) attempt run.
      await vi.advanceTimersByTimeAsync(10);
      expect(onAcquired).toHaveBeenCalledTimes(1);
      expect(onAcquired).toHaveBeenCalledWith({ epoch: 1n, writerUrl: "http://node-a:4000" });

      mgr.stop();

      // Advance well past several more retry intervals — nothing further should fire.
      await vi.advanceTimersByTimeAsync(10 * 10);
      expect(onAcquired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquireLoop() survives a transient tryAcquire() rejection and keeps retrying", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000", retryMs: 10 });
      await mgr.setup();

      const original = mgr.tryAcquire.bind(mgr);
      let calls = 0;
      vi.spyOn(mgr, "tryAcquire").mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient connection error");
        return original();
      });

      const onAcquired = vi.fn();
      mgr.acquireLoop(onAcquired);

      // First attempt rejects; loop must not die — it should reschedule and succeed on retry.
      await vi.advanceTimersByTimeAsync(10);
      expect(onAcquired).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(onAcquired).toHaveBeenCalledTimes(1);
      expect(onAcquired).toHaveBeenCalledWith({ epoch: 1n, writerUrl: "http://node-a:4000" });

      mgr.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("CHECK (id = 1) constraint is enforced on the fleet_lease table", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();

    // Attempt to insert a row with id=2 should violate the CHECK constraint and fail.
    await expect(
      client.query(
        "INSERT INTO fleet_lease (id, epoch, writer_url, acquired_at) VALUES (2, 1, 'http://test:4000', now())",
      ),
    ).rejects.toThrow();
  });
});
