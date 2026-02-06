import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "@stackbase/objectstore/test-support/memory-objectstore";
import { isCasConflict } from "@stackbase/objectstore";
import { casManifest, createManifest, readManifest, type Manifest } from "../src/manifest";

describe("manifest helpers", () => {
  it("createManifest seeds an empty manifest; a second create on the same shard is a CasConflict", async () => {
    const os = new MemoryObjectStore();
    const created = await createManifest(os, "0");
    expect(created.manifest).toEqual({
      epoch: 0,
      frontierTs: "0",
      tsCounter: "0",
      segments: [],
      nextSeqno: 0,
      writerId: "",
      leaseExpiresAt: "0",
    });
    expect(typeof created.etag).toBe("string");

    await expect(createManifest(os, "0")).rejects.toSatisfy((e: unknown) => isCasConflict(e));
  });

  it("readManifest returns null for an uninitialized shard, and the manifest+etag once created", async () => {
    const os = new MemoryObjectStore();
    expect(await readManifest(os, "0")).toBeNull();

    const created = await createManifest(os, "0");
    const read = await readManifest(os, "0");
    expect(read).not.toBeNull();
    expect(read!.manifest).toEqual(created.manifest);
    expect(read!.etag).toBe(created.etag);
  });

  it("readManifest is scoped per-shard", async () => {
    const os = new MemoryObjectStore();
    await createManifest(os, "0");
    expect(await readManifest(os, "1")).toBeNull();
  });

  it("casManifest with the right etag succeeds, returns a new etag, and is durably read back", async () => {
    const os = new MemoryObjectStore();
    const { manifest, etag } = await createManifest(os, "0");
    const next: Manifest = { ...manifest, frontierTs: "1", tsCounter: "1", segments: [0] };

    const { etag: nextEtag } = await casManifest(os, "0", next, etag);
    expect(nextEtag).not.toBe(etag);

    const read = await readManifest(os, "0");
    expect(read!.manifest).toEqual(next);
    expect(read!.etag).toBe(nextEtag);
  });

  it("casManifest with a stale etag throws CasConflict and does not overwrite the current manifest", async () => {
    const os = new MemoryObjectStore();
    const { manifest, etag: etag1 } = await createManifest(os, "0");
    const next1: Manifest = { ...manifest, frontierTs: "1", tsCounter: "1", segments: [0] };
    const { etag: etag2 } = await casManifest(os, "0", next1, etag1);

    // etag1 is now stale — a second CAS attempt using it must be rejected
    const staleNext: Manifest = { ...next1, frontierTs: "2", tsCounter: "2", segments: [0, 1] };
    await expect(casManifest(os, "0", staleNext, etag1)).rejects.toSatisfy((e: unknown) => isCasConflict(e));

    // the winning write (etag2 / next1) must still be what's stored — no partial/silent overwrite
    const read = await readManifest(os, "0");
    expect(read!.manifest).toEqual(next1);
    expect(read!.etag).toBe(etag2);
  });

  it("tsCounter strictly increases across successive CASes (monotone-content invariant)", async () => {
    const os = new MemoryObjectStore();
    let { manifest, etag } = await createManifest(os, "0");
    let prevCounter = BigInt(manifest.tsCounter);
    expect(prevCounter).toBe(0n);

    for (let i = 1; i <= 5; i++) {
      const next: Manifest = { ...manifest, frontierTs: String(i), tsCounter: String(i), segments: [...manifest.segments, i - 1] };
      const result = await casManifest(os, "0", next, etag);
      const counter = BigInt(next.tsCounter);
      expect(counter).toBeGreaterThan(prevCounter);
      prevCounter = counter;
      manifest = next;
      etag = result.etag;
    }
    expect(manifest.segments).toEqual([0, 1, 2, 3, 4]);
  });
});
