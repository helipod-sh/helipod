import { describe, it, expect } from "vitest";
import type { ClientTransport } from "@stackbase/client";
import { offlineToggleTransport } from "../web/offline-transport";

type Sent = Parameters<ClientTransport["send"]>[0];

function fakeInnerFactory() {
  const instances: Array<{ sent: Sent[]; closed: boolean }> = [];
  const make = (_url: string): ClientTransport => {
    const inst = { sent: [] as Sent[], closed: false };
    instances.push(inst);
    return {
      send: (m) => inst.sent.push(m),
      onMessage: () => () => {},
      onClose: () => () => {},
      onReopen: () => () => {},
      close: () => {
        inst.closed = true;
      },
    };
  };
  return { make, instances };
}

function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set("packlist:offline", initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: map,
  };
}

const MSG = { type: "Ping" } as unknown as Sent; // opaque to the wrapper — it never inspects frames

describe("offlineToggleTransport", () => {
  it("online at construction: creates an inner transport and forwards sends", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    expect(instances).toHaveLength(1);
    t.send(MSG);
    expect(instances[0]!.sent).toEqual([MSG]);
  });

  it("setOffline(true): closes the inner, fires close listeners once, drops sends, persists the flag", () => {
    const { make, instances } = fakeInnerFactory();
    const storage = fakeStorage();
    const t = offlineToggleTransport("ws://x/api/sync", make, storage);
    let closes = 0;
    t.onClose(() => closes++);

    t.setOffline(true);
    expect(instances[0]!.closed).toBe(true);
    expect(closes).toBe(1);
    expect(storage.dump.get("packlist:offline")).toBe("1");

    t.send(MSG);
    expect(instances[0]!.sent).toEqual([]); // dropped, not delivered to the dead inner

    t.setOffline(true); // idempotent — no second close event
    expect(closes).toBe(1);
  });

  it("setOffline(false): creates a FRESH inner, fires reopen, forwards sends to the new inner", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    let reopens = 0;
    t.onReopen!(() => reopens++);

    t.setOffline(true);
    t.setOffline(false);
    expect(instances).toHaveLength(2);
    expect(reopens).toBe(1);

    t.send(MSG);
    expect(instances[1]!.sent).toEqual([MSG]);
    expect(instances[0]!.sent).toEqual([]);
  });

  it("a persisted offline flag starts the transport offline (reload-while-offline stays offline)", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage("1"));
    expect(t.isOffline()).toBe(true);
    expect(instances).toHaveLength(0); // no socket ever attempted

    let reopens = 0;
    t.onReopen!(() => reopens++);
    t.setOffline(false);
    expect(instances).toHaveLength(1);
    expect(reopens).toBe(1); // the client rebuilds the session on first go-online
  });

  it("onStateChange fires on every flip with the new value", () => {
    const { make } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    const seen: boolean[] = [];
    t.onStateChange((o) => seen.push(o));
    t.setOffline(true);
    t.setOffline(false);
    expect(seen).toEqual([true, false]);
  });

  it("close() is terminal: drops the inner and ignores later setOffline calls", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    t.close();
    expect(instances[0]!.closed).toBe(true);
    t.setOffline(false);
    expect(instances).toHaveLength(1); // no resurrection
  });
});
