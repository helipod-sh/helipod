import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "@helipod/objectstore/test-support/memory-objectstore";
import { isCasConflict } from "@helipod/objectstore";
import { createGlobals, ensureGlobals, readGlobals, type FleetGlobals } from "../src/globals";

describe("fleet globals", () => {
  it("readGlobals returns null on an empty bucket, and the globals once created", async () => {
    const os = new MemoryObjectStore();
    expect(await readGlobals(os)).toBeNull();

    const globals: FleetGlobals = { deploymentId: "dep-1", numShards: 1 };
    await createGlobals(os, globals);
    expect(await readGlobals(os)).toEqual(globals);
  });

  it("createGlobals is create-only: a second create on the same bucket is a CasConflict", async () => {
    const os = new MemoryObjectStore();
    await createGlobals(os, { deploymentId: "dep-1", numShards: 1 });

    await expect(createGlobals(os, { deploymentId: "dep-2", numShards: 2 })).rejects.toSatisfy((e: unknown) =>
      isCasConflict(e),
    );
    // the loser's globals must not have landed
    expect(await readGlobals(os)).toEqual({ deploymentId: "dep-1", numShards: 1 });
  });

  it("ensureGlobals on an empty bucket writes and returns the given globals", async () => {
    const os = new MemoryObjectStore();
    const globals: FleetGlobals = { deploymentId: "dep-1", numShards: 1 };
    const result = await ensureGlobals(os, globals);
    expect(result).toEqual(globals);
    expect(await readGlobals(os)).toEqual(globals);
  });

  it("a second ensureGlobals with a DIFFERENT deploymentId adopts the first — never overwrites", async () => {
    const os = new MemoryObjectStore();
    const first = await ensureGlobals(os, { deploymentId: "dep-1", numShards: 1 });
    const second = await ensureGlobals(os, { deploymentId: "dep-2", numShards: 3 });

    expect(second).toEqual(first);
    expect(second.deploymentId).toBe("dep-1");
    expect(await readGlobals(os)).toEqual(first);
  });

  it("concurrent ensureGlobals (create race) converge on the SAME winner", async () => {
    const os = new MemoryObjectStore();
    const [a, b] = await Promise.all([
      ensureGlobals(os, { deploymentId: "dep-A", numShards: 1 }),
      ensureGlobals(os, { deploymentId: "dep-B", numShards: 2 }),
    ]);

    expect(a.deploymentId).toBe(b.deploymentId);
    expect(a.numShards).toBe(b.numShards);
    expect(a).toEqual(b);

    // whichever won, the bucket's persisted globals must match what both callers observed
    expect(await readGlobals(os)).toEqual(a);
  });
});
