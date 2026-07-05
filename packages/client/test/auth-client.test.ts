import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAuthClient,
  localStorageSession,
  memorySession,
  type AuthManagedClient,
  type PairBroadcast,
  type RefreshLock,
  type SessionInfo,
} from "../src/auth-client"; // own-package tests import via src, per the existing client test idiom
import { HelipodClient } from "../src/client";
import { memoryOutbox } from "../src/outbox-storage";
import type { ClientMessage, ServerMessage } from "@helipod/sync";

// A minimal transport for the fingerprint-switch tests below (same shape as the existing
// set-auth.test.ts / outbox-enqueue.test.ts MockTransport, kept local to avoid cross-file coupling).
class MinimalTransport {
  readonly sent: ClientMessage[] = [];
  private readonly msg = new Set<(m: ServerMessage) => void>();
  private readonly closers = new Set<() => void>();
  send(m: ClientMessage): void { this.sent.push(m); }
  onMessage(l: (m: ServerMessage) => void): () => void { this.msg.add(l); return () => this.msg.delete(l); }
  onClose(l: () => void): () => void { this.closers.add(l); return () => this.closers.delete(l); }
  close(): void { for (const l of this.closers) l(); }
}

// Default timeout is generous: the real-timer block below relies on SubtleCrypto digests that
// resolve off a real threadpool, and under full-monorepo parallel `bun run test` load that
// threadpool can be starved for well over a second. 10s of headroom keeps the assertion
// deterministic (it still returns the instant `cond` is true) without flaking under CPU pressure.
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// A stub `AuthManagedClient` recording setAuth/fingerprint calls and driving a scripted `mutation`.
function stubClient(): AuthManagedClient & { auths: (string | null)[]; fps: (string | null)[]; onRefresh: (rt: string) => Promise<SessionInfo> } {
  const s = {
    auths: [] as (string | null)[],
    fps: [] as (string | null)[],
    onRefresh: async (_rt: string) => { throw new Error("no refresh scripted"); },
    setAuth(t: string | null) { s.auths.push(t); },
    setSessionFingerprint(id: string | null) { s.fps.push(id); },
    async mutation(_ref: string, args?: Record<string, unknown>): Promise<unknown> {
      return s.onRefresh((args as { refreshToken: string }).refreshToken);
    },
  };
  return s;
}

// An in-process broadcast + lock shared across two simulated tabs.
function sharedBus(): { broadcast: () => PairBroadcast; lock: RefreshLock } {
  const subs = new Set<(i: SessionInfo) => void>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    broadcast: () => {
      let mine: ((i: SessionInfo) => void) | undefined;
      return {
        post: (i) => { for (const cb of subs) if (cb !== mine) cb(i); },
        onMessage: (cb) => { mine = cb; subs.add(cb); },
        close: () => { if (mine) subs.delete(mine); },
      };
    },
    lock: { run: <T>(fn: () => Promise<T>) => { const n = tail.then(fn, fn); tail = n.catch(() => {}); return n as Promise<T>; } },
  };
}

function mint(seq: number, expiresAt: number): SessionInfo {
  return { token: `at${seq}`, refreshToken: `rt${seq}`, sessionId: "s1", userId: "u1", expiresAt };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createAuthClient", () => {
  it("applies a session: setAuth + sessionId fingerprint, and schedules refresh at 80% of the TTL", async () => {
    const c = stubClient();
    const start = 1_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    let refreshed = false;
    c.onRefresh = async () => { refreshed = true; return mint(2, start + 3_600_000); };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} } });

    auth.setSession(mint(1, start + 3_600_000)); // 1h TTL
    expect(c.auths).toEqual(["at1"]);
    expect(c.fps).toEqual(["s1"]);                // fingerprint from sessionId, not token

    vi.advanceTimersByTime(3_600_000 * 0.8 - 1);
    expect(refreshed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);         // cross the 80% mark
    expect(refreshed).toBe(true);
    expect(c.auths.at(-1)).toBe("at2");           // rotated access token applied
    auth.close();
  });

  it("two tabs: only one refresher runs; the loser adopts the winner's broadcast pair", async () => {
    const bus = sharedBus();
    const start = 2_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();               // shared "storage" both tabs read/write
    const cA = stubClient();
    const cB = stubClient();
    let refreshCalls = 0;
    // `expiresAt` must be STRICTLY greater than `initial`'s below — the recency guard (`isNewer`)
    // only adopts a foreign/re-read pair when it's newer, and a real rotation always mints a later
    // `expiresAt`, so this reflects reality rather than the coincidental same-TTL pair from before.
    const winner = mint(9, start + 3_600_000 + 60_000);
    cA.onRefresh = async () => { refreshCalls++; storage.save(winner); return winner; };
    cB.onRefresh = async () => { refreshCalls++; storage.save(winner); return winner; };

    const tabA = createAuthClient(cA, { storage, now: () => Date.now(), lock: bus.lock, broadcast: bus.broadcast() });
    const tabB = createAuthClient(cB, { storage, now: () => Date.now(), lock: bus.lock, broadcast: bus.broadcast() });
    const initial = mint(1, start + 3_600_000);
    tabA.setSession(initial);
    tabB.setSession(initial);

    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5);
    // NOTE (deviation from the task-4 brief's literal test body): the brief's snippet followed this
    // with an additional `await vi.runOnlyPendingTimersAsync();`. That call fires EVERY timer already
    // registered regardless of how far out its delay is — including the *next* refresh cycle's timer
    // that `apply(winner)` schedules for both tabs once they adopt the winning pair. That flush was
    // firing an extra genuine refresh cycle — a real behavior of the "reschedule after every apply"
    // design, not a bug in it. It's dropped here because it's incidental to what this test is
    // asserting: exactly one network refresh happens for the ORIGINAL rotation race. Confirmed by
    // isolated run that dropping it alone (no other change) yields refreshCalls === 1 with both tabs
    // on "at9".
    // The lock + storage re-read means only ONE network refresh actually happened; the other tab
    // adopted the winning pair (via storage re-read under the lock and/or the broadcast).
    expect(refreshCalls).toBe(1);
    expect(cA.auths.at(-1)).toBe("at9");
    expect(cB.auths.at(-1)).toBe("at9");
    tabA.close();
    tabB.close();
  });

  it("REFRESH_EXPIRED clears storage and fires onSignedOut", async () => {
    const c = stubClient();
    const start = 3_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    const signedOut = vi.fn();
    c.onRefresh = async () => { const e = new Error("REFRESH_EXPIRED"); (e as Error & { code?: string }).code = "REFRESH_EXPIRED"; throw e; };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} }, onSignedOut: signedOut });
    auth.setSession(mint(1, start + 3_600_000));
    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(storage.load()).toBeNull();
    expect(c.auths.at(-1)).toBeNull();
    auth.close();
  });

  it("REFRESH_REUSED (same terminal branch as REFRESH_EXPIRED) clears storage and fires onSignedOut", async () => {
    const c = stubClient();
    const start = 3_100_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    const signedOut = vi.fn();
    c.onRefresh = async () => { const e = new Error("REFRESH_REUSED"); (e as Error & { code?: string }).code = "REFRESH_REUSED"; throw e; };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} }, onSignedOut: signedOut });
    auth.setSession(mint(1, start + 3_600_000));
    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(storage.load()).toBeNull();
    expect(c.auths.at(-1)).toBeNull();
    auth.close();
  });

  it("REFRESH_STALE waits for the broadcast winner instead of signing out", async () => {
    const c = stubClient();
    const start = 4_000_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    const signedOut = vi.fn();
    // Strictly newer than the initial pair's `expiresAt` below — required by the recency guard.
    const winner = mint(7, start + 3_600_000 + 60_000);
    c.onRefresh = async () => { const e = new Error("REFRESH_STALE"); (e as Error & { code?: string }).code = "REFRESH_STALE"; throw e; };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} }, onSignedOut: signedOut });
    auth.setSession(mint(1, start + 3_600_000));
    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5); // triggers refresh → REFRESH_STALE
    storage.save(winner);                                    // the winner tab's pair lands in storage
    await vi.advanceTimersByTimeAsync(300);                  // the 250ms wait-for-broadcast elapses
    expect(signedOut).not.toHaveBeenCalled();
    expect(c.auths.at(-1)).toBe("at7");                      // adopted the winner
    auth.close();
  });

  it("broadcast: an OLDER incoming pair (lower expiresAt) is ignored — no regression", async () => {
    // The recency guard (`isNewer`): an older/foreign pair delivered via broadcast must never
    // regress the current pair — that can cascade into a spurious REFRESH_REUSED forced sign-out
    // (using a since-superseded refresh token) or a zero-delay retry loop.
    const c = stubClient();
    const start = 4_500_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    let deliver: ((info: SessionInfo) => void) | undefined;
    const broadcast: PairBroadcast = {
      post() {},
      onMessage(cb) { deliver = cb; },
      close() {},
    };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast });
    const current = mint(5, start + 3_600_000);
    auth.setSession(current);
    const authsBefore = c.auths.length;
    const fpsBefore = c.fps.length;

    const older = mint(4, start + 1_800_000); // lower expiresAt = an OLDER generation
    deliver?.(older);

    expect(auth.getSessionInfo()).toEqual(current); // untouched in memory
    expect(storage.load()).toEqual(current);        // untouched in storage
    expect(c.auths.length).toBe(authsBefore);        // no additional setAuth call
    expect(c.fps.length).toBe(fpsBefore);            // no additional fingerprint call either
    auth.close();
  });

  it("generic refresh errors back off exponentially (capped at 60s), and the failure count resets on success", async () => {
    const c = stubClient();
    const start = 4_700_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    const callTimes: number[] = [];
    let mode: "fail" | "succeed" = "fail";
    c.onRefresh = async () => {
      callTimes.push(Date.now());
      if (mode === "fail") throw new Error("ECONNRESET"); // generic/transient — no `.code`
      return mint(99, Date.now() + 2000);                 // short TTL: next cycle arrives quickly
    };
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} } });
    auth.setSession(mint(1, start + 3_600_000));

    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5); // call #1 fails → backoff 1s scheduled
    await vi.advanceTimersByTimeAsync(1000 + 5);             // call #2 fails → backoff 2s scheduled
    await vi.advanceTimersByTimeAsync(2000 + 5);             // call #3 fails → backoff 4s scheduled
    expect(callTimes.length).toBe(3);
    expect(callTimes[1]! - callTimes[0]!).toBe(1000);        // grew 1s → 2s
    expect(callTimes[2]! - callTimes[1]!).toBe(2000);        // grew 2s → 4s

    mode = "succeed";
    await vi.advanceTimersByTimeAsync(4000 + 5);             // call #4 succeeds → counter resets;
                                                              // schedule()s next cycle at 80% of 2000ms
    expect(callTimes.length).toBe(4);
    expect(c.auths.at(-1)).toBe("at99");

    mode = "fail";
    await vi.advanceTimersByTimeAsync(1600 + 5);             // call #5 fails → backoff restarts at 1s
    expect(callTimes.length).toBe(5);
    await vi.advanceTimersByTimeAsync(1000 + 5);             // if reset: call #6 at +1000ms (not +8000ms)
    expect(callTimes.length).toBe(6);
    auth.close();
  });

  it("zero-config defaults (no lock/broadcast override) still complete a refresh rotation", async () => {
    // `defaultLock()`/`defaultBroadcast()` are otherwise untested — every other test injects fakes.
    // This must pass whether the runtime provides Web Locks/BroadcastChannel or falls back to the
    // in-process serializer/no-op — assert only that the refresh happened and state advanced.
    const c = stubClient();
    const start = 4_900_000;
    vi.setSystemTime(start);
    const storage = memorySession();
    const onSignedOut = vi.fn();
    let refreshed = false;
    c.onRefresh = async () => { refreshed = true; return mint(2, Date.now() + 3_600_000); };
    const auth = createAuthClient(c, { storage, onSignedOut });
    auth.setSession(mint(1, start + 3_600_000));
    await vi.advanceTimersByTimeAsync(3_600_000 * 0.8 + 5);
    expect(refreshed).toBe(true);
    expect(c.auths.at(-1)).toBe("at2");
    expect(auth.getSessionInfo()?.refreshToken).toBe("rt2");
    expect(onSignedOut).not.toHaveBeenCalled();
    auth.close();
  });

  it("getSessionInfo returns a shallow copy, not the live internal object", () => {
    const c = stubClient();
    const storage = memorySession();
    const auth = createAuthClient(c, { storage, now: () => Date.now(), lock: { run: (f) => f() }, broadcast: { post() {}, onMessage() {}, close() {} } });
    const session = mint(1, 123);
    auth.setSession(session);
    const got = auth.getSessionInfo();
    expect(got).toEqual(session);
    expect(got).not.toBe(session); // not the caller's own object identity
    if (got) got.token = "tampered";
    expect(auth.getSessionInfo()?.token).toBe("at1"); // mutating the returned copy didn't touch internal state
    auth.close();
  });

  it("localStorageSession falls back to memory where localStorage is unavailable (Node)", () => {
    // Under Node/vitest there is no `localStorage` global — the probe must degrade to the
    // in-memory store transparently (same probe-and-fallback shape as `indexedDBOutbox`).
    const s = localStorageSession();
    expect(s.load()).toBeNull();
    const m = mint(1, 123);
    s.save(m);
    expect(s.load()).toEqual(m);
    s.clear();
    expect(s.load()).toBeNull();
  });
});

// The outbox identityFingerprint switch (spec decision 9), against a REAL HelipodClient — proves
// (a) the raw `setAuth(token)` path (no `createAuthClient`) is BYTE-IDENTICAL to pre-A1 behavior
// (token-hash fingerprint, still flips on every rotation), and (b) once `createAuthClient` calls
// `setSessionFingerprint`, the fingerprint is pinned to the stable sessionId and does NOT move
// across a token rotation — the exact property that keeps queued offline mutations from being
// orphaned mid-drain by a refresh.
describe("outbox identityFingerprint switch — raw setAuth vs managed sessionId (spec decision 9)", () => {
  beforeEach(() => vi.useRealTimers()); // SubtleCrypto digests resolve off a real threadpool

  it("raw setAuth(token): fingerprint is the token hash and CHANGES on every rotation (unchanged from pre-A1)", async () => {
    const t = new MinimalTransport();
    const client = new HelipodClient(t, { outbox: memoryOutbox() });

    client.setAuth("tok-1");
    await waitFor(() => client.__outboxFingerprint !== "anon");
    const fp1 = client.__outboxFingerprint;
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);

    client.setAuth("tok-2"); // simulates a raw rotation with no createAuthClient involved
    await waitFor(() => client.__outboxFingerprint !== fp1);
    const fp2 = client.__outboxFingerprint;
    expect(fp2).not.toBe(fp1); // token-hash fingerprint moves with every token — old-caller-unchanged
  });

  it("managed session: fingerprint derives from sessionId and stays STABLE across a token rotation", async () => {
    const t = new MinimalTransport();
    const client = new HelipodClient(t, { outbox: memoryOutbox() });

    client.setSessionFingerprint("sess-1");
    await waitFor(() => client.__outboxFingerprint !== "anon");
    const fpBeforeRotation = client.__outboxFingerprint;

    // A rotation: setAuth is called with a NEW token but the SAME sessionId re-applied (this is what
    // `createAuthClient.apply()` does on every `setSession`/rotation — setSessionFingerprint first,
    // then setAuth). The guard on `setAuth` must suppress its own token-hash recompute.
    client.setAuth("tok-rotated-1");
    client.setSessionFingerprint("sess-1");
    // Give any (suppressed) async token-hash recompute a chance to run, if it were going to.
    await new Promise((r) => setTimeout(r, 20));
    expect(client.__outboxFingerprint).toBe(fpBeforeRotation); // unchanged — pinned to sessionId

    client.setAuth("tok-rotated-2");
    client.setSessionFingerprint("sess-1");
    await new Promise((r) => setTimeout(r, 20));
    expect(client.__outboxFingerprint).toBe(fpBeforeRotation); // still unchanged after a 2nd rotation

    // Sanity: a DIFFERENT sessionId does produce a different fingerprint (it's not a constant).
    client.setSessionFingerprint("sess-2");
    await waitFor(() => client.__outboxFingerprint !== fpBeforeRotation);
    expect(client.__outboxFingerprint).not.toBe(fpBeforeRotation);
  });

  it("setSessionFingerprint(null) hands the fingerprint back to the raw setAuth token-hash path", async () => {
    const t = new MinimalTransport();
    const client = new HelipodClient(t, { outbox: memoryOutbox() });

    client.setAuth("tok-A");
    client.setSessionFingerprint("sess-1"); // now managed — token-hash recompute suppressed
    await waitFor(() => client.__outboxFingerprint !== "anon");
    const managedFp = client.__outboxFingerprint;

    client.setAuth("tok-B"); // rotation while managed: must NOT move the fingerprint
    await new Promise((r) => setTimeout(r, 20));
    expect(client.__outboxFingerprint).toBe(managedFp);

    client.setSessionFingerprint(null); // sign-out: hand fingerprinting back to setAuth
    await waitFor(() => client.__outboxFingerprint !== managedFp);
    expect(client.__outboxFingerprint).toMatch(/^[0-9a-f]{64}$/); // now the hash of "tok-B" (lastAuthToken)

    client.setAuth("tok-C"); // and the raw path resumes moving normally
    const afterNullFp = client.__outboxFingerprint;
    await waitFor(() => client.__outboxFingerprint !== afterNullFp);
  });
});
