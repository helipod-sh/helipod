/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * `WriteForwarder`'s Receipted Outbox owner-placement threading (verdict §(c) repair 3): a resend
 * through a NON-owner node carries the durable `(clientId, seq)` dedup key in the `/_fleet/run` body
 * so the OWNER — never this node's replica — classifies it. When the owner replays a recorded verdict
 * (`clientReplay` in the response), `forward()` surfaces it as `{ value, replay }` and does NOT wait
 * on the local replica (a replay committed nothing this call).
 *
 * Pure forwarder-logic unit tests: a stubbed global `fetch` stands in for the owner's `/_fleet/run`,
 * a stub `PgClient` backs the `LeaseManager` (writer-URL discovery) — same harness shape as
 * `forwarder-ryow.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PgClient, PgQuerier, PgRow, PgValue } from "@helipod/docstore-postgres";
import { LeaseManager } from "../src/lease";
import { WriteForwarder, type ReplicaWaiter } from "../src/forwarder";

class StubPgClient implements PgClient {
  async query(): Promise<PgRow[]> {
    return [{ epoch: 1n, writer_url: "http://owner:4000" }];
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

class NoopWaiter implements ReplicaWaiter {
  waited = false;
  async waitFor(): Promise<"reached" | "timeout" | "released"> {
    this.waited = true;
    return "reached";
  }
  release(): void {}
}

let lease: LeaseManager;
let originalFetch: typeof fetch;

beforeEach(() => {
  lease = new LeaseManager(new StubPgClient(), { advertiseUrl: "http://self:4001" });
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeForwarder(): WriteForwarder {
  return new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://self:4001" });
}

describe("WriteForwarder — Receipted Outbox owner-placement (dedup threading)", () => {
  it("carries the (clientId, seq) dedup key in the /_fleet/run body so the OWNER classifies", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse((init as RequestInit).body as string));
      return new Response(JSON.stringify({ value: 1, committed: true, commitTs: "5" }), { status: 200 });
    });
    const forwarder = makeForwarder();
    await forwarder.forward("mutation", "notes:add", { body: "x" }, "user-1", "default", { clientId: "c1", seq: 4 });
    expect(bodies[0]).toMatchObject({ path: "notes:add", clientId: "c1", seq: 4, forwarded: true });
  });

  it("surfaces the owner's clientReplay as { value, replay } and skips the replica RYOW wait", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ clientReplay: { verdict: "applied", commitTs: 9, value: { ok: true } } }),
          { status: 200 },
        ),
    );
    const forwarder = makeForwarder();
    const tailer = new NoopWaiter();
    forwarder.attachTailer(tailer);

    const out = await forwarder.forward("mutation", "notes:add", {}, null, "default", { clientId: "c1", seq: 2 });
    expect(out.replay).toMatchObject({ verdict: "applied", commitTs: 9 });
    expect(out.value).toEqual({ ok: true });
    expect(tailer.waited).toBe(false); // a replay committed nothing — no read-your-own-writes wait
  });

  it("a plain (non-dedup) forward omits clientId/seq — byte-for-byte the shipped body", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse((init as RequestInit).body as string));
      return new Response(JSON.stringify({ value: 1, committed: true, commitTs: "5" }), { status: 200 });
    });
    const forwarder = makeForwarder();
    await forwarder.forward("mutation", "notes:add", {}, null);
    expect(bodies[0]).not.toHaveProperty("clientId");
    expect(bodies[0]).not.toHaveProperty("seq");
  });
});
