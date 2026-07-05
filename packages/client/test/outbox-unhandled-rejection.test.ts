/**
 * Final whole-branch review (fs-outbox) — Important finding: `client.ts` consumes the
 * `OutboxStorage` seam via several fire-and-forget calls (`void this.outbox.xxx(...).then(...)`,
 * no `.catch`). `fsOutbox()`'s designed fail-stop contract (`OutboxClosedError`, code
 * `OUTBOX_CLOSED` — see `src/outbox-fs.ts`) means a real disk error, or a close() race, makes
 * EVERY subsequent op reject permanently. Node/Electron hosts treat an unhandled promise
 * rejection as fatal by default — this test proves the composed crash shape and pins the fix
 * (every fire-and-forget outbox write routes its rejection to the R9 observability channel
 * instead: `onMutationFailed`, or the dev-mode loud `console.error` default).
 *
 * A stub `OutboxStorage` stands in for a fail-stopped `fsOutbox()` — the seam is what matters
 * here, not fs specifics (append() always rejects with a `code: "OUTBOX_CLOSED"` error, exactly
 * the shape `OutboxClosedError` has).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { HelipodClient, type MutationFailedInfo, type OutboxEntry, type OutboxMeta, type OutboxStorage } from "../src/index";
import type { ClientMessage, ServerMessage } from "@helipod/sync";

class MockTransport {
  readonly sent: ClientMessage[] = [];
  private readonly msg = new Set<(m: ServerMessage) => void>();
  private readonly closers = new Set<() => void>();
  private readonly reopeners = new Set<() => void>();
  send(m: ClientMessage): void {
    this.sent.push(m);
  }
  onMessage(l: (m: ServerMessage) => void): () => void {
    this.msg.add(l);
    return () => this.msg.delete(l);
  }
  onClose(l: () => void): () => void {
    this.closers.add(l);
    return () => this.closers.delete(l);
  }
  onReopen(l: () => void): () => void {
    this.reopeners.add(l);
    return () => this.reopeners.delete(l);
  }
  close(): void {}
  mutations(): Array<Extract<ClientMessage, { type: "Mutation" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Mutation" }> => m.type === "Mutation");
  }
}

class FailStoppedError extends Error {
  readonly code = "OUTBOX_CLOSED";
  constructor() {
    super("fsOutbox is closed; this operation's outcome is UNKNOWN");
    this.name = "OutboxClosedError";
  }
}

/** Every mutating method always rejects — the fail-stopped-`fsOutbox` shape (a disk error, or an
 *  op racing/after close()), reduced to the bare seam. */
function failStoppedOutbox(): OutboxStorage {
  const reject = () => Promise.reject(new FailStoppedError());
  return {
    append: reject,
    updateStatus: reject,
    dequeue: reject,
    loadAll: async () => ({ entries: [], dropped: [] }),
    getMeta: async () => undefined,
    setMeta: reject,
    listMetaClientIds: async () => [],
    deleteMeta: reject,
    persist: () => {},
    close: async () => {},
  } satisfies OutboxStorage;
}

void ({} as OutboxEntry); // keep the type import used even if a future edit trims direct references
void ({} as OutboxMeta);

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("client.ts — fire-and-forget outbox writes must never become an unhandled rejection", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled = [];
  });

  it("a rejecting (fail-stopped) outbox.append() during mutation() surfaces via onMutationFailed, not as an unhandledRejection", async () => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);

    const t = new MockTransport();
    const onMutationFailed = vi.fn<(info: MutationFailedInfo) => void>();
    const client = new HelipodClient(t, {
      outbox: failStoppedOutbox(),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      onMutationFailed,
    });

    // Fire a mutation — the durable append() is called fire-and-forget and (with this stub) always
    // rejects. Swallow the mutation's own promise rejection/resolution separately; what's under
    // test is the SEPARATE durable-write failure, not the wire round trip.
    client.mutation("messages:send", { body: "hi" }).catch(() => {});

    await tick();
    // Give a real unhandledRejection a chance to surface — Node schedules the event on a later
    // microtask/macrotask turn than the rejection itself.
    await new Promise((r) => setTimeout(r, 20));

    expect(unhandled).toEqual([]); // the fix: no unhandled rejection reaches the process
    expect(onMutationFailed).toHaveBeenCalled(); // and the failure is NOT silently swallowed either
    const call = onMutationFailed.mock.calls[0]![0];
    expect(call.udfPath).toBe("messages:send");
    expect(call.error.message).toMatch(/durable outbox append failed/);
  });

  it("dev-mode loud console.error default fires for a rejecting outbox write with no onMutationFailed registered", async () => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    vi.stubEnv("NODE_ENV", "development");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const t = new MockTransport();
    const client = new HelipodClient(t, { outbox: failStoppedOutbox(), outboxLocks: null, outboxDrainIntervalMs: 0 });
    client.mutation("messages:send", { body: "hi" }).catch(() => {});

    await tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(unhandled).toEqual([]);
    const loud = errSpy.mock.calls.filter((c) => String(c[0]).includes("durable outbox"));
    expect(loud.length).toBeGreaterThan(0);

    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
