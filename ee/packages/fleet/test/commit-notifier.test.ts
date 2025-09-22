/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `NotifyingFanoutAdapter` — the writer-side commit-notify wrapper. (The slice-1 `CommitTailer`
 * that used to live alongside it was removed in slice 2; its follower-side derive-and-invalidate
 * behavior is now `ReplicaTailer`'s, covered in `replica-tailer.test.ts`.)
 */
import { describe, it, expect, vi } from "vitest";
import type { EmbeddedWriteFanoutAdapter, EmbeddedWriteFanoutPayload, FanoutListener } from "@stackbase/runtime-embedded";
import { NotifyingFanoutAdapter } from "../src/commit-notifier";

describe("NotifyingFanoutAdapter", () => {
  it("delegates publish/subscribe to the inner adapter and NOTIFYs stackbase_commits per publish", () => {
    const published: EmbeddedWriteFanoutPayload[] = [];
    const listeners = new Set<FanoutListener>();
    const inner: EmbeddedWriteFanoutAdapter = {
      publish: vi.fn((payload: EmbeddedWriteFanoutPayload) => {
        published.push(payload);
        for (const l of listeners) l(payload);
      }),
      subscribe: vi.fn((listener: FanoutListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const notify = vi.fn(async (_channel: string, _payload: string) => {});
    const client = { notify } as unknown as never;

    const adapter = new NotifyingFanoutAdapter(inner, client);

    const received: EmbeddedWriteFanoutPayload[] = [];
    const unsubscribe = adapter.subscribe((p) => received.push(p));
    expect(inner.subscribe).toHaveBeenCalledTimes(1);

    const payload: EmbeddedWriteFanoutPayload = {
      commitTs: 42,
      tables: ["10001"],
      ranges: [],
      originId: "origin-a",
      shardId: "default",
    };
    adapter.publish(payload);

    expect(inner.publish).toHaveBeenCalledWith(payload);
    expect(published).toEqual([payload]);
    expect(received).toEqual([payload]); // delegated subscribe also observes it
    expect(notify).toHaveBeenCalledWith("stackbase_commits", "42");

    unsubscribe();
  });
});
