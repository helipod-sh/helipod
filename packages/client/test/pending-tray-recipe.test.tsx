// @vitest-environment jsdom
/**
 * T5 (c): `usePendingMutations()` through a REAL rendered React tree, and the documented
 * pending-tray recipe as a COMPILING docs fixture (mirrors `optimistic-store.test.ts`'s "type-level
 * compile fixture" pattern — `PendingTray`/`appendMessage` below are exactly the shape
 * `docs/enduser/offline.md` documents; `bun run --filter @stackbase/client typecheck` is what
 * actually proves the types, this file proves it also RUNS).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import {
  StackbaseClient,
  memoryOutbox,
  OUTBOX_VERSION,
  type OptimisticUpdateFn,
  type OutboxBroadcastLike,
  type OutboxEntry,
  type OutboxStorage,
} from "../src/index";
import { StackbaseProvider, usePendingMutations } from "../src/react";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

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
  emit(m: ServerMessage): void {
    for (const l of this.msg) l(m);
  }
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function seedOutbox(
  storage: OutboxStorage,
  clientId: string,
  rows: Array<{ seq: number; order: number; body?: string; status?: OutboxEntry["status"]; error?: OutboxEntry["error"] }>,
): Promise<void> {
  for (const r of rows) {
    const entry: OutboxEntry = {
      clientId,
      seq: r.seq,
      requestId: `old-${r.seq}`,
      udfPath: "messages:send",
      args: { body: r.body ?? `b${r.seq}` },
      seed: { entropy: `e${r.seq}`, now: 1000 + r.seq },
      order: r.order,
      status: r.status ?? "unsent",
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: 1000 + r.seq,
      error: r.error,
    };
    await storage.append(entry);
  }
}

class FakeBroadcastBus {
  readonly channels = new Set<FakeBroadcastChannel>();
}
class FakeBroadcastChannel implements OutboxBroadcastLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(private readonly bus: FakeBroadcastBus) {
    bus.channels.add(this);
  }
  postMessage(message: unknown): void {
    for (const c of this.bus.channels) if (c !== this) c.onmessage?.({ data: message });
  }
  close(): void {
    this.bus.channels.delete(this);
  }
}

/* ================================================================================================
 * The documented pending-tray recipe (`docs/enduser/offline.md`) — verbatim shape, compiled + run.
 * ================================================================================================ */
function PendingTray() {
  const pending = usePendingMutations();
  return (
    <ul aria-label="pending-tray">
      {pending.map((entry) => (
        <li key={`${entry.clientId}:${entry.seq}`} aria-label="pending-row">
          <span aria-label="udfPath">{entry.udfPath}</span>
          <span aria-label="status">{entry.status}</span>
          {entry.status === "failed" && (
            <>
              <span aria-label="error">{entry.error?.message}</span>
              <button onClick={() => void entry.retry()}>retry</button>
              <button onClick={() => void entry.dismiss()}>dismiss</button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The "undefined-tolerant updater" pattern (verdict §(d) honest boundary: "the documented
 *  `if (list === undefined) return` recipe") — a registered updater MUST tolerate `getQuery`
 *  returning `undefined` (no persisted query baseline exists pre-reconnect). */
const appendMessage: OptimisticUpdateFn = (store, args) => {
  const list = store.getQuery("messages:list", {}) as Array<{ _id: string; body: string }> | undefined;
  if (list === undefined) return; // renders nothing until the baseline arrives — never throws
  const { body } = args as { body: string };
  store.setQuery("messages:list", {}, [...list, { _id: store.placeholderId("messages"), body }]);
};

afterEach(cleanup);

describe("usePendingMutations() — reactive over the durable store, through a real render (T5 R9)", () => {
  it("renders the durable backlog and re-renders on a local outbox change", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "c", [{ seq: 0, order: 0, body: "a" }]);
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });

    render(
      <StackbaseProvider client={client}>
        <PendingTray />
      </StackbaseProvider>,
    );
    await waitFor(() => expect(screen.getAllByLabelText("pending-row")).toHaveLength(1));

    void client.mutation("messages:send", { body: "b" });
    await waitFor(() => expect(screen.getAllByLabelText("pending-row")).toHaveLength(2));
  });

  it("re-renders on a CROSS-TAB nudge (a faked BroadcastChannel, two client instances sharing one durable store)", async () => {
    const outbox = memoryOutbox();
    const bus = new FakeBroadcastBus();
    const clientA = new StackbaseClient(new MockTransport(), {
      outbox,
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      outboxBroadcast: new FakeBroadcastChannel(bus),
    });
    const clientB = new StackbaseClient(new MockTransport(), {
      outbox,
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      outboxBroadcast: new FakeBroadcastChannel(bus),
    });

    render(
      <StackbaseProvider client={clientB}>
        <PendingTray />
      </StackbaseProvider>,
    );
    await waitFor(() => expect(screen.queryAllByLabelText("pending-row")).toHaveLength(0));

    // Tab A enqueues — tab B's tray updates via the BroadcastChannel nudge, never touching clientA.
    void clientA.mutation("messages:send", { body: "from A" });
    await waitFor(() => expect(screen.getAllByLabelText("pending-row")).toHaveLength(1));
  });

  it("a failed entry's retry()/dismiss() buttons work end-to-end through the rendered tray", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "c", [{ seq: 0, order: 0, body: "boom", status: "failed", error: { message: "went wrong", code: "APP_ERR" } }]);
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });

    render(
      <StackbaseProvider client={client}>
        <PendingTray />
      </StackbaseProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("error").textContent).toBe("went wrong"));

    fireEvent.click(screen.getByText("dismiss"));
    await waitFor(() => expect(screen.queryAllByLabelText("pending-row")).toHaveLength(0));
  });

  it("retry() clears the failed row and re-enqueues a fresh one (unsent, not failed)", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "c", [{ seq: 0, order: 0, body: "boom", status: "failed", error: { message: "went wrong", code: "APP_ERR" } }]);
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });

    render(
      <StackbaseProvider client={client}>
        <PendingTray />
      </StackbaseProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("error").textContent).toBe("went wrong"));

    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(screen.queryAllByLabelText("error")).toHaveLength(0));
    expect(screen.getAllByLabelText("pending-row")).toHaveLength(1);
    expect(screen.getByLabelText("status").textContent).not.toBe("failed");
  });
});

describe("the undefined-tolerant registry updater — compiling docs fixture (T5)", () => {
  it("a hydrated entry with a registered updater that tolerates an undefined base drains without throwing", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [{ seq: 0, order: 0, body: "hi" }]);
    const client = new StackbaseClient(new MockTransport(), {
      outbox,
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": appendMessage },
    });
    await tick();
    // No crash, no layer materialized (the base was undefined — no query ever subscribed) — the
    // entry still hydrated cleanly into the log (the documented recipe's whole point).
    expect(client.__pending).toHaveLength(1);
  });
});
