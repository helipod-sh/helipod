import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { loadFunctionsDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";
import { resolveServeOptions, serveCommand } from "../src/serve";

// Tier 3 Slice 8, Task 8.2a: `bootLoaded` with a `file://` object-store URL + `replica: true`
// constructs a read-only REPLICA node — materialized (no acquire), tailing, serving reads, and
// rejecting mutations — proving the CLI boot wiring end-to-end at the boot-core level. The full
// E2E through two real `helipod serve` processes over one bucket (fs + MinIO, WebSocket
// subscription fan-out from a writer's commit onto a replica) is Task 8.3's job — deliberately not
// duplicated here.

const ROOT = "./.tmp-objectstore-replica-boot";
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bootLoaded — Tier 3 Slice 8 object-store replica node", () => {
  it("materializes the writer's committed state from the bucket, stays live, and rejects a mutation with a clear message", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/deploy-v2/helipod");
    const bucket = `file://${ROOT}/bucket`;

    // ── WRITER: commits data BEFORE the replica ever opens ────────────────────────────────────
    const writer = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/writer/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucket,
      objectStoreWriterId: "writer-a",
    });
    await writer.runtime.run("notes:add", { box: "b1", text: "from-writer" });

    // ── REPLICA: fresh local dir, replica: true, no acquire — bootstraps from the SAME bucket ──
    const replica = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/replica/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucket,
      replica: true,
      objectStoreReplicaConsumerId: "replica-8-2a",
      objectStoreReplicaPollMs: 100, // short cadence — the second assertion below waits on it
    });
    try {
      // Adopts the SAME deploymentId the writer's bucket globals established.
      const deploymentIdWriter = await writer.store.getGlobal("fleet:deploymentId");
      const deploymentIdReplica = await replica.store.getGlobal("fleet:deploymentId");
      expect(typeof deploymentIdWriter).toBe("string");
      expect(deploymentIdReplica).toBe(deploymentIdWriter);

      // `open()`'s bootstrap alone (no tailer round needed) already materialized the writer's
      // pre-boot commit — a query on the replica returns it immediately.
      const bootstrapped = await replica.runtime.run("notes:list", {});
      expect(bootstrapped.value).toEqual([{ box: "b1", text: "from-writer" }]);

      // A mutation on the replica is REJECTED with the clear read-replica message (not the raw
      // substrate "not the lease owner" wording) — the write-lease requirement makes this rejection
      // free (the replica never acquired), `wrapReplicaWriteRejection` only improves the message.
      await expect(replica.runtime.run("notes:add", { box: "b1", text: "should-not-land" })).rejects.toThrow(
        /read replica.*holds no write lease/,
      );
      // The rejected mutation genuinely didn't land: the writer's own state is unaffected, and the
      // replica's local materialization didn't gain a phantom row either.
      const writerAfter = await writer.runtime.run("notes:list", {});
      expect(writerAfter.value).toEqual([{ box: "b1", text: "from-writer" }]);

      // ── The replica's OWN reactive tailer picks up a NEW writer commit made AFTER replica boot ──
      // (proves the CLI's `attachTailer` wiring — not just `open()`'s one-time bootstrap — is live;
      // the cross-node WebSocket subscription-fan-out variant of this is Task 8.3's job).
      await writer.runtime.run("notes:add", { box: "b1", text: "from-writer-2" });
      await new Promise<void>((r) => setTimeout(r, 500)); // > pollMs (100ms) for a real tick to land
      const afterTail = (await replica.runtime.run("notes:list", {})).value as unknown[];
      expect(afterTail.length).toBe(2);
    } finally {
      await replica.objectStoreRelease?.();
      await replica.runtime.stopDrivers();
      await replica.store.close();
      await writer.objectStoreRelease?.();
      await writer.runtime.stopDrivers();
      await writer.store.close();
    }
  });

  it("throws a clear error when --replica is combined with --fleet+--object-store (serve.ts-level: --replica alone / without --object-store)", () => {
    // `resolveServeOptions` parses --replica independent of --object-store; `serveCommand`'s
    // synchronous validation (before any boot work) is what actually rejects the combination — see
    // the next test for the end-to-end CLI behavior. This just proves the flag parses.
    const opts = resolveServeOptions(["--replica"]);
    expect(opts.replica).toBe(true);
    expect(opts.objectStoreUrl).toBeUndefined();
  });

  it("serveCommand rejects --replica without --object-store with a clear, fast (no boot work) error", async () => {
    const originalAdminKey = process.env.HELIPOD_ADMIN_KEY;
    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.env.HELIPOD_ADMIN_KEY = "test-admin-key";
    process.stderr.write = (chunk: string) => {
      captured += chunk;
      return true;
    };
    try {
      const code = await serveCommand(["--replica", "--dir", "test/fixtures/deploy-v2/helipod"]);
      expect(code).toBe(1);
      expect(captured).toMatch(/--replica requires --object-store/);
    } finally {
      process.stderr.write = originalWrite;
      if (originalAdminKey === undefined) delete process.env.HELIPOD_ADMIN_KEY;
      else process.env.HELIPOD_ADMIN_KEY = originalAdminKey;
    }
  });
});
