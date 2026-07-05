/**
 * Subscription resume — server-minted result fingerprints (design 2026-07-11, Task 1: server
 * half). The server hashes its own serialized result and attaches it to every `QueryUpdated`
 * (subscribe answer AND reactive re-run pushes); a client echoing that hash back on resubscribe
 * gets `QueryUnchanged` instead of the payload when the fresh re-run's hash still matches.
 *
 * Uses the same controllable-`SyncUdfExecutor` + mock-socket harness as `origin-frontier.test.ts`.
 */
import { describe, it, expect } from "vitest";
import type { SerializedKeyRange } from "@helipod/index-key-codec";
import { SyncProtocolHandler, type SyncUdfExecutor, type ServerMessage } from "../src/index";

type Transition = Extract<ServerMessage, { type: "Transition" }>;
type Modification = Transition["modifications"][number];

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function sock() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send: (d: string) => sent.push(JSON.parse(d) as ServerMessage),
    bufferedAmount: 0,
    close: () => {},
    transitions: () => sent.filter((m): m is Transition => m.type === "Transition"),
    modifications: () => sent.filter((m): m is Transition => m.type === "Transition").flatMap((t) => t.modifications),
  };
}

/** Controllable executor: `queryValue`/`queryTables`/`shouldFail` drive what `runQuery` returns. */
function mkExec(opts: {
  queryValue?: () => unknown;
  queryTables?: string[];
  queryRanges?: SerializedKeyRange[];
  shouldFail?: () => boolean;
} = {}): SyncUdfExecutor {
  return {
    async runQuery() {
      if (opts.shouldFail?.()) throw new Error("boom");
      const value = (opts.queryValue?.() ?? "v") as never;
      return { value, tables: opts.queryTables ?? ["t"], readRanges: opts.queryRanges ?? [], globalTables: [] };
    },
    async runMutation() {
      return { value: "ok" as never, tables: [], writeRanges: [], commitTs: 0 };
    },
    async runAdminQuery() {
      return { value: "admin" as never, tables: ["t"], readRanges: [], globalTables: [] };
    },
    async runAction() {
      return { value: "acted" as never };
    },
  };
}

const subscribe = (h: SyncProtocolHandler, s: string, queryId: number, resultHash?: string) =>
  h.handleMessage(
    s,
    JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId, udfPath: "app:q", args: {}, resultHash }], remove: [] }),
  );

function findUpdated(mods: Modification[], queryId: number) {
  return mods.find((m) => m.type === "QueryUpdated" && m.queryId === queryId) as
    | Extract<Modification, { type: "QueryUpdated" }>
    | undefined;
}
function findUnchanged(mods: Modification[], queryId: number) {
  return mods.find((m) => m.type === "QueryUnchanged" && m.queryId === queryId);
}
function findFailed(mods: Modification[], queryId: number) {
  return mods.find((m) => m.type === "QueryFailed" && m.queryId === queryId);
}

describe("subscription resume — server-minted result fingerprints", () => {
  it("1. every QueryUpdated (subscribe answer AND reactive push) carries a well-formed hash", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["t"], queryValue: () => "v1" }), {
      autoNotifyOnMutation: false,
    });
    const s = sock();
    h.connect("s1", s as never);

    await subscribe(h, "s1", 1);
    const subAnswer = findUpdated(s.modifications(), 1);
    expect(subAnswer).toBeDefined();
    expect(subAnswer!.hash).toMatch(HASH_RE);

    s.sent.length = 0;
    await h.notifyWrites({ tables: ["t"], ranges: [], commitTs: 1 });
    const pushed = findUpdated(s.modifications(), 1);
    expect(pushed).toBeDefined();
    expect(pushed!.hash).toMatch(HASH_RE);
  });

  it("2. resubscribing with the CURRENT hash -> QueryUnchanged, not QueryUpdated", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["t"], queryValue: () => "v1" }), {
      autoNotifyOnMutation: false,
    });
    const s = sock();
    h.connect("s1", s as never);

    await subscribe(h, "s1", 1);
    const initialHash = findUpdated(s.modifications(), 1)!.hash!;
    s.sent.length = 0;

    await subscribe(h, "s1", 1, initialHash);
    const mods = s.modifications();
    expect(findUnchanged(mods, 1)).toBeDefined();
    expect(findUpdated(mods, 1)).toBeUndefined();
  });

  it("3. after an Unchanged resume, a write intersecting the read set still pushes a full QueryUpdated", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["t"], queryValue: () => "v1" }), {
      autoNotifyOnMutation: false,
    });
    const s = sock();
    h.connect("s1", s as never);

    await subscribe(h, "s1", 1);
    const initialHash = findUpdated(s.modifications(), 1)!.hash!;
    s.sent.length = 0;

    // Resume — resolves to QueryUnchanged, but registration must still be fresh.
    await subscribe(h, "s1", 1, initialHash);
    expect(findUnchanged(s.modifications(), 1)).toBeDefined();
    s.sent.length = 0;

    // A write intersecting the (freshly re-registered) read set must still invalidate and push.
    await h.notifyWrites({ tables: ["t"], ranges: [], commitTs: 1 });
    const mods = s.modifications();
    const pushed = findUpdated(mods, 1);
    expect(pushed).toBeDefined();
    expect(pushed!.hash).toMatch(HASH_RE);
  });

  it("4. resubscribing with a WRONG hash -> full QueryUpdated with the current hash", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["t"], queryValue: () => "v1" }), {
      autoNotifyOnMutation: false,
    });
    const s = sock();
    h.connect("s1", s as never);

    await subscribe(h, "s1", 1);
    const initialHash = findUpdated(s.modifications(), 1)!.hash!;
    s.sent.length = 0;

    await subscribe(h, "s1", 1, "sha256:" + "0".repeat(64));
    const mods = s.modifications();
    const updated = findUpdated(mods, 1);
    expect(updated).toBeDefined();
    expect(updated!.value).toBe("v1");
    expect(updated!.hash).toMatch(HASH_RE);
    expect(updated!.hash).toBe(initialHash); // value unchanged -> same fingerprint
    expect(findUnchanged(mods, 1)).toBeUndefined();
  });

  it("5. no resultHash on the add entry -> always full QueryUpdated, never QueryUnchanged (old-client path)", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["t"], queryValue: () => "v1" }), {
      autoNotifyOnMutation: false,
    });
    const s = sock();
    h.connect("s1", s as never);

    await subscribe(h, "s1", 1); // no resultHash
    s.sent.length = 0;
    await subscribe(h, "s1", 1); // resubscribe again, still no resultHash
    const mods = s.modifications();
    expect(findUpdated(mods, 1)).toBeDefined();
    expect(mods.some((m) => m.type === "QueryUnchanged")).toBe(false);
  });

  it("6. a failing query -> QueryFailed with no hash, and echoing any hash never converts it to Unchanged", async () => {
    const h = new SyncProtocolHandler(mkExec({ shouldFail: () => true }), { autoNotifyOnMutation: false });
    const s = sock();
    h.connect("s1", s as never);

    await subscribe(h, "s1", 1);
    const failed = findFailed(s.modifications(), 1) as Extract<Modification, { type: "QueryFailed" }> | undefined;
    expect(failed).toBeDefined();
    expect((failed as unknown as { hash?: string }).hash).toBeUndefined();
    s.sent.length = 0;

    // Echo an arbitrary hash — even a real-looking one — on the retry; must stay QueryFailed.
    await subscribe(h, "s1", 1, "sha256:" + "a".repeat(64));
    const mods = s.modifications();
    expect(findFailed(mods, 1)).toBeDefined();
    expect(findUnchanged(mods, 1)).toBeUndefined();
    expect(findUpdated(mods, 1)).toBeUndefined();
  });
});
