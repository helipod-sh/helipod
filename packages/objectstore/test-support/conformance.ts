import { describe, it, expect, afterAll } from "vitest";
import { isCasConflict, type ObjectStore } from "../src/types";

/** Await `p`, assert it rejects, and assert the rejection is a `CasConflict` (structural check
 *  via `isCasConflict`, never `instanceof` — see `../src/types`). */
async function expectCasConflict(p: Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    expect(isCasConflict(e)).toBe(true);
  }
  expect(threw).toBe(true);
}

export function runObjectStoreConformance(
  label: string,
  makeStore: () => ObjectStore | Promise<ObjectStore>,
  teardown?: () => Promise<void> | void,
): void {
  describe(`ObjectStore conformance: ${label}`, () => {
    afterAll(async () => {
      await teardown?.();
    });

    it("putImmutable then get round-trips bytes; get(absent) is null", async () => {
      const store = await makeStore();
      const data = new TextEncoder().encode("hello objectstore");
      await store.putImmutable("seg/1", data);
      const round = await store.get("seg/1");
      expect(round).not.toBeNull();
      expect(new TextDecoder().decode(round!.body)).toBe("hello objectstore");

      expect(await store.get("seg/does-not-exist")).toBeNull();
    });

    it("casPut(k, b, null) creates and returns an etag; a second create-only casPut throws CasConflict", async () => {
      const store = await makeStore();
      const b1 = new TextEncoder().encode("v1");
      const res1 = await store.casPut("cas/create", b1, null);
      expect(typeof res1.etag).toBe("string");
      expect(res1.etag.length).toBeGreaterThan(0);

      const b2 = new TextEncoder().encode("v2");
      await expectCasConflict(store.casPut("cas/create", b2, null));

      // and the original body must be untouched by the rejected create-only attempt
      const round = await store.get("cas/create");
      expect(new TextDecoder().decode(round!.body)).toBe("v1");
    });

    it("casPut(k, b, currentEtag) succeeds and returns a NEW etag", async () => {
      const store = await makeStore();
      const b1 = new TextEncoder().encode("v1");
      const { etag: etag1 } = await store.casPut("cas/update", b1, null);

      const b2 = new TextEncoder().encode("v2");
      const { etag: etag2 } = await store.casPut("cas/update", b2, etag1);
      expect(etag2).not.toBe(etag1);

      const round = await store.get("cas/update");
      expect(round!.etag).toBe(etag2);
      expect(new TextDecoder().decode(round!.body)).toBe("v2");
    });

    it("casPut(k, b, wrongEtag) throws CasConflict", async () => {
      const store = await makeStore();
      await store.casPut("cas/wrong", new TextEncoder().encode("v1"), null);
      await expectCasConflict(store.casPut("cas/wrong", new TextEncoder().encode("v4"), "wrong-etag"));
    });

    it("one-winner race: exactly one of R concurrent casPuts against the same base etag succeeds", async () => {
      const store = await makeStore();
      const { etag: baseEtag } = await store.casPut("cas/race", new TextEncoder().encode("base"), null);

      const R = 8;
      // THE trap: bodies MUST differ per racer, else identical content -> identical etag and a
      // broken store that doesn't actually enforce the If-Match condition could still pass.
      const results = await Promise.allSettled(
        Array.from({ length: R }, (_, i) =>
          store.casPut("cas/race", new TextEncoder().encode(`racer-${i}`), baseEtag),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(R - 1);
      for (const r of rejected) {
        if (r.status === "rejected") expect(isCasConflict(r.reason)).toBe(true);
      }

      // the surviving body must be exactly one racer's distinct body, not a merge/corruption
      const round = await store.get("cas/race");
      const wonBody = new TextDecoder().decode(round!.body);
      expect(wonBody).toMatch(/^racer-\d+$/);
      const winner = fulfilled[0];
      if (winner && winner.status === "fulfilled") expect(round!.etag).toBe(winner.value.etag);
    });

    it("list(prefix) returns exactly the keys under that prefix", async () => {
      const store = await makeStore();
      await store.putImmutable("list/a/1", new TextEncoder().encode("x"));
      await store.putImmutable("list/a/2", new TextEncoder().encode("x"));
      await store.putImmutable("list/b/1", new TextEncoder().encode("x"));
      await store.putImmutable("other/1", new TextEncoder().encode("x"));

      const keys = await store.list("list/a/");
      expect(new Set(keys)).toEqual(new Set(["list/a/1", "list/a/2"]));
    });

    it("delete(k) then get(k) is null", async () => {
      const store = await makeStore();
      await store.putImmutable("del/1", new TextEncoder().encode("x"));
      expect(await store.get("del/1")).not.toBeNull();

      await store.delete("del/1");
      expect(await store.get("del/1")).toBeNull();
    });

    it("assertCasSupported resolves for a conforming store", async () => {
      const store = await makeStore();
      // no throw = pass; a non-conforming store rejects and fails this test
      await store.assertCasSupported();
    });
  });
}
