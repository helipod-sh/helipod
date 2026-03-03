# Multi-shard replicas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the object-storage replica boot path from single-shard (tails only shard `"0"`) to N lanes, so `stackbase serve --object-store <url> --replica` against a multi-shard bucket materializes + tails + serves reactivity for every lane.

**Architecture:** Approach A (see `docs/superpowers/specs/2026-02-20-multi-shard-replicas-design.md`): mirror `buildObjectStoreWriterNode`'s single→N generalization. Read `globals.numShards` (authoritative), open one materialize-only `ObjectStoreDocStore` per `shardIdList(N)` lane behind the shipped `ShardedObjectStoreDocStore` read composite, and start N independent `startReplicaReactiveTailer` instances (one per lane, per-lane consumer watermark) feeding one runtime. Every mutation is single-lane, so lanes tail independently with no coordination; `observeTimestamp` is monotonic-max so N lanes advancing it is safe.

**Tech Stack:** TypeScript (Bun workspaces + Turborepo), `@stackbase/objectstore-substrate` (ee), `packages/cli` boot/serve, vitest under Node, real MinIO container for the ship-gate E2E.

## Global Constraints

- **Byte-identical single-shard path.** `numShards === 1` (born-single OR resharded-to-1) MUST behave exactly as today: one lane over shard `"0"`, consumer watermark id is the bare `baseConsumerId` (NO `:0` suffix — the shipped E2E asserts `s0/consumers/<id>`), `dataPath` used verbatim (no `.<shard>` suffix). Every existing objectstore replica test must stay green unchanged.
- **A replica NEVER writes the bucket** except its own consumer watermark: no `acquire`, no heartbeat, no gc, no snapshot. Materialize + tail only.
- **Lane bucket prefixes:** `numShards > 1` → the canonical `shardIdList(numShards)` ids (`["default","s1",…]`), identity with the engine's routing shardIds — the SAME convention the writer path + `objectstore reshard` use. `numShards === 1` → the single `"0"` lane.
- **ee-gated:** the reshard/replica substrate is dynamically imported + entitlement-gated exactly like the existing replica path; `packages/cli` keeps zero static dependency on the ee substrate.
- **Authoritative shard count from the bucket:** the replica reads `numShards` from `globals` (adopt-never-mint), never from a flag — a replica has no `--shards` flag.

---

### Task 1: Generalize `buildObjectStoreReplicaNode` to N lanes + N tailers; wire `bootLoaded` numShards

**Files:**
- Modify: `packages/cli/src/boot.ts` — `buildObjectStoreReplicaNode` (currently ~450-494), the `bootLoaded` numShards branch (~875), and three stale "replicas are single-shard" comments (~774, ~869, ~873-874).
- Test: `packages/cli/test/objectstore-replica-multishard-boot.test.ts` (create).

**Interfaces:**
- Consumes: `resolveObjectStore`, `loadObjectStoreSubstrateModule`, `makeLocalSqliteStore(dataPath): SqliteDocStore`, `wrapReplicaWriteRejection(store): DocStore`, `defaultReplicaConsumerId()`, `DEFAULT_OBJECTSTORE_REPLICA_POLL_MS`, `RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY`, `shardIdList`, `DEFAULT_SHARD`; substrate `ensureGlobals`, `ObjectStoreDocStore.open`, `ShardedObjectStoreDocStore`, `startReplicaReactiveTailer`, `removeConsumer`.
- Produces: `buildObjectStoreReplicaNode(...) → { store: DocStore; numShards: number; attachTailer: (runtime) => () => Promise<void> }` — a NEW `numShards` field (additive; the writer node already returns one).

- [ ] **Step 1: Write the failing test** — `packages/cli/test/objectstore-replica-multishard-boot.test.ts`. Uses the channelId-sharded `shard-dev` fixture via `bootLoaded` (in-process push — no committed `_generated` needed). Boot a `--shards 3` writer, commit messages to three channels that route to three DISTINCT lanes at M=3, boot a replica (no `--shards`; derives 3 from the bucket), assert: (a) the replica reads every channel back through the composite, (b) after a poll each lane published its own watermark under `s{shard}/consumers/`, (c) a mutation is rejected with the read-replica message.

```ts
/**
 * Multi-shard replica boot (multi-shard-replicas Task 1): a `--shards 3` writer over a channelId-
 * sharded fixture; a replica derives 3 lanes from the bucket's globals, materializes + reads every
 * lane through the composite, publishes a per-lane consumer watermark, and rejects writes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { shardIdForKeyValue } from "@stackbase/id-codec";
import { loadConvexDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";

const ROOT = "./.tmp-objectstore-replica-ms-boot";
const FIXTURE = "test/fixtures/shard-dev/convex";
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bootLoaded — multi-shard object-store replica", () => {
  it("a 3-shard replica materializes + reads every lane, publishes a per-lane watermark, rejects writes", async () => {
    const loaded = await loadConvexDir(FIXTURE);
    const bucketDir = `${ROOT}/bucket`;
    const bucket = `file://${bucketDir}`;
    const channels = ["b3", "b4", "b1"];
    expect(new Set(channels.map((c) => shardIdForKeyValue(c, 3))).size).toBe(3); // three distinct lanes

    const writer = await bootLoaded({
      loaded, components: [], dataPath: `${ROOT}/writer/db.sqlite`, adminKey: "k",
      objectStoreUrl: bucket, objectStoreWriterId: "w", objectStoreShards: 3,
    });
    await writer.runtime.run("messages:send", { channelId: "b3", body: "m3" });
    await writer.runtime.run("messages:send", { channelId: "b4", body: "m4" });
    await writer.runtime.run("messages:send", { channelId: "b1", body: "m1" });

    const replica = await bootLoaded({
      loaded, components: [], dataPath: `${ROOT}/replica/db.sqlite`, adminKey: "k",
      objectStoreUrl: bucket, replica: true,
      objectStoreReplicaConsumerId: "rep-ms", objectStoreReplicaPollMs: 80,
    });
    try {
      // (a) reads every lane's channel through the composite
      for (const [ch, body] of [["b3", "m3"], ["b4", "m4"], ["b1", "m1"]] as const) {
        const rows = (await replica.runtime.run("messages:list", { channelId: ch })).value as Array<{ body: string }>;
        expect(rows.map((r) => r.body)).toEqual([body]);
      }
      // (b) each lane published its own watermark (wait out a couple poll cadences)
      await new Promise<void>((r) => setTimeout(r, 300));
      const inspector = new FsObjectStore({ dir: bucketDir });
      for (const shardId of ["default", "s1", "s2"]) {
        const wm = await inspector.list(`s${shardId}/consumers/`);
        expect(wm.length, `lane '${shardId}' watermark`).toBeGreaterThan(0);
      }
      // (c) writes rejected
      await expect(replica.runtime.run("messages:send", { channelId: "b3", body: "x" })).rejects.toThrow(
        /read replica.*holds no write lease/,
      );
    } finally {
      await replica.objectStoreRelease?.();
      await replica.runtime.stopDrivers();
      await replica.store.close();
      await writer.objectStoreRelease?.();
      await writer.runtime.stopDrivers();
      await writer.store.close();
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd packages/cli && bunx vitest run test/objectstore-replica-multishard-boot.test.ts`. Expected FAIL: the current single-shard replica only opens shard `"0"`, so `messages:list` for `b4`/`b1` (lanes s1/s2) returns `[]` and the s1/s2 watermarks never appear.

- [ ] **Step 3: Generalize `buildObjectStoreReplicaNode`** — replace its body (keep the doc comment, updating the "single-shard" wording). New implementation:

```ts
async function buildObjectStoreReplicaNode(opts: {
  objectStoreUrl: string;
  dataPath: string;
  consumerId?: string;
  pollMs?: number;
}): Promise<{
  store: DocStore;
  numShards: number;
  attachTailer: (runtime: EmbeddedRuntime) => () => Promise<void>;
}> {
  const resolved = resolveObjectStore(opts.objectStoreUrl);
  if (resolved === null) {
    throw new Error(`stackbase: --object-store "${opts.objectStoreUrl}" did not resolve to a store (empty/unset value?).`);
  }
  await resolved.objectStore.assertCasSupported();
  const substrate = await loadObjectStoreSubstrateModule();
  const objectStore = resolved.objectStore;

  // Adopt-not-mint identity (never re-mint a deploymentId) — the returned count is AUTHORITATIVE: a
  // multi-shard bucket (writer `--shards N`, or `objectstore reshard`) boots the right lanes with no
  // `--shards` flag on the replica at all.
  const globals = await substrate.ensureGlobals(objectStore, { deploymentId: randomUUID(), numShards: 1 });
  const numShards = globals.numShards;
  const shardIds: string[] = numShards > 1 ? [...shardIdList(numShards)] : ["0"];

  // Open + MATERIALIZE each lane (NO acquire — a replica claims no ownership). Each lane its own local
  // file (`<dataPath>.<shardId>` for multi-shard; the bare `dataPath` for the byte-identical single lane).
  const lanes: Array<{ shardId: string; store: DocStore; local: SqliteDocStore }> = [];
  for (const shardId of shardIds) {
    const laneDataPath = numShards > 1 ? `${opts.dataPath}.${shardId}` : opts.dataPath;
    const local = makeLocalSqliteStore(laneDataPath);
    const laneStore = await substrate.ObjectStoreDocStore.open({ objectStore, shard: shardId, local });
    await laneStore.writeGlobalIfAbsent(RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY, globals.deploymentId);
    lanes.push({ shardId, store: laneStore, local });
  }

  // Single lane → the store directly (byte-identical). Multi-shard → the shipped fan-out+merge composite,
  // whose default lane is `shardIdList(N)[0] === "default"` (where deployment globals resolve).
  const composite: DocStore =
    numShards === 1
      ? lanes[0]!.store
      : new substrate.ShardedObjectStoreDocStore(new Map(lanes.map((l) => [l.shardId, l.store])), {
          defaultShard: DEFAULT_SHARD,
        });
  const store = wrapReplicaWriteRejection(composite);

  const baseConsumerId = opts.consumerId ?? defaultReplicaConsumerId();
  const pollMs = opts.pollMs ?? DEFAULT_OBJECTSTORE_REPLICA_POLL_MS;
  // Per-lane watermark id: bare `baseConsumerId` for the single lane (byte-compat — the shipped E2E
  // asserts `s0/consumers/<id>`); `${baseConsumerId}:${shardId}` per lane for multi-shard, so each
  // lane's watermark floors only THAT lane's writer gc.
  const laneConsumerId = (shardId: string): string => (numShards === 1 ? baseConsumerId : `${baseConsumerId}:${shardId}`);

  return {
    store,
    numShards,
    attachTailer: (runtime: EmbeddedRuntime) => {
      // One tailer per lane, all driving the SAME runtime's reactive fan-out. `observeTimestamp` is
      // monotonic-max, so independent per-lane advances are safe; every commit is single-lane, so no
      // cross-lane ordering is needed.
      const handles = lanes.map((l) =>
        substrate.startReplicaReactiveTailer({
          runtime,
          objectStore,
          shard: l.shardId,
          local: l.local,
          consumerId: laneConsumerId(l.shardId),
          pollMs,
        }),
      );
      return async () => {
        await Promise.all(handles.map((h) => h.stop()));
        await Promise.all(lanes.map((l) => substrate.removeConsumer(objectStore, l.shardId, laneConsumerId(l.shardId))));
      };
    },
  };
}
```

- [ ] **Step 4: Wire `bootLoaded` numShards from the replica node** — at the `else if (objectStoreWriterNode || objectStoreReplicaNode)` branch (~875), change:

```ts
    numShards = objectStoreReplicaNode ? 1 : (objectStoreWriterNode?.numShards ?? 1);
```
to:
```ts
    // Authoritative count from the bucket's globals — a writer built exactly its lanes; a replica
    // derives the same count and composes the same-sized read composite + one tailer per lane.
    numShards = objectStoreWriterNode?.numShards ?? objectStoreReplicaNode?.numShards ?? 1;
```

- [ ] **Step 5: Fix the three stale "replicas are single-shard" comments** — update the wording at the `opts.objectStoreShards` doc (~774: "and for a `--replica` boot (replicas are single-shard)"), the numShards-branch comment (~869: "A REPLICA stays single-shard (it tails shard "0"; multi-shard replicas are a later follow-on).") and (~873-874: "A replica stays single-shard (multi-shard replicas are a later follow-on).") to state that a replica now derives its lane count from the bucket globals exactly like the writer. No logic change — comment accuracy only.

- [ ] **Step 6: Run the test to verify it passes** — `cd packages/cli && bunx vitest run test/objectstore-replica-multishard-boot.test.ts`. Expected PASS (all 3 assertions).

- [ ] **Step 7: Run the existing objectstore suites for no-regression** — `cd packages/cli && bunx vitest run test/objectstore-replica-boot.test.ts test/objectstore-boot.test.ts test/objectstore-fail-fast.test.ts`. Expected: all green (single-shard path byte-identical).

- [ ] **Step 8: Typecheck** — `bun run --filter @stackbase/cli typecheck`. Expected exit 0 (test file is in the `test` include).

- [ ] **Step 9: Commit** —
```bash
git add packages/cli/src/boot.ts packages/cli/test/objectstore-replica-multishard-boot.test.ts
git commit -m "feat(objectstore): multi-shard replica — N-lane materialize + tail"
```

---

### Task 2: Real-`serve` multi-shard writer + replica E2E (fs always; MinIO ship gate)

**Files:**
- Create: `packages/cli/test/fixtures/shard-dev/convex/_generated/*` (codegen the sharded fixture so `serve` — which never codegens at boot — can run it).
- Test: `packages/cli/test/objectstore-replica-multishard-e2e.test.ts` (create).

**Interfaces:**
- Consumes: the Task-1 `buildObjectStoreReplicaNode` (already merged via `serve`); the existing E2E harness patterns in `packages/cli/test/objectstore-replica-e2e.test.ts` (`startServe`, `run`, WebSocket subscription helper) and `objectstore-serve-e2e.test.ts` (MinIO container gate).

- [ ] **Step 1: Codegen the sharded fixture's `_generated`** — run `stackbase codegen --dir packages/cli/test/fixtures/shard-dev/convex` (or the in-repo codegen entrypoint the other fixtures were generated with — confirm by matching `deploy-v2/convex/_generated`'s file set: `api.d.ts`, `dataModel.d.ts`, `ids.ts`, `server.d.ts`, etc.). Verify it compiles: `bun run --filter @stackbase/cli typecheck`.

- [ ] **Step 2: Write the E2E** — model on `objectstore-replica-e2e.test.ts` but: the writer starts with `--shards 3` (env `STACKBASE_FLEET_SHARDS=3` or the `--shards` flag the serve path accepts), the fixture is `shard-dev` (channelId-sharded), the replica starts with just `--object-store <url> --replica` (derives 3 from the bucket). Two real `serve` processes over ONE bucket. Assertions, per the design's test plan:
  1. The replica adopts the writer's `deploymentId` and materializes the writer's pre-boot committed messages across all 3 lanes (read each channel back).
  2. Open a WebSocket subscription on the REPLICA to `messages:list` for a channel whose lane is `s1` (not the default lane — proving a NON-default lane's tailer drives reactivity); commit a `messages:send` to that channel on the WRITER via `POST /api/run`; the replica subscription FIRES with the new row.
  3. A `messages:send` on the REPLICA is rejected with the read-replica message; the writer's data is unaffected.
  4. Each lane published a consumer watermark — `s{default,s1,s2}/consumers/<id>:<shard>` each has a non-negative `appliedSeqno`.
  5. Graceful shutdown (replica first): `removeConsumer` ran for every lane (each lane's `consumers/` prefix is empty after release).
- Structure the container-dependent half exactly like `objectstore-serve-e2e.test.ts` (skip when MinIO env is absent; run against the real bucket when present). The fs half runs always.

- [ ] **Step 3: Run the fs half** — `cd packages/cli && bunx vitest run test/objectstore-replica-multishard-e2e.test.ts`. Expected PASS on fs.

- [ ] **Step 4: Run the MinIO ship gate** (if a MinIO container/creds are available in the environment) — the same invocation with the MinIO env vars set. If unavailable in-sandbox, note it explicitly in the commit body as an unrun ship gate (the arc's honest-placeholder convention), and rely on the fs half + the single-shard MinIO E2E that already exists.

- [ ] **Step 5: Typecheck + full objectstore suite** — `bun run --filter @stackbase/cli typecheck` and `cd packages/cli && bunx vitest run test/objectstore-*.test.ts`. Expected all green.

- [ ] **Step 6: Commit** —
```bash
git add packages/cli/test/fixtures/shard-dev/convex/_generated packages/cli/test/objectstore-replica-multishard-e2e.test.ts
git commit -m "test(objectstore): multi-shard writer+replica E2E through real serve"
```

---

## Self-Review

- **Spec coverage:** Task 1 covers design §1/§2/§3 (N lanes behind the composite, N tailers, bootLoaded numShards). Task 2 covers the design's test plan (boot-level + real-serve E2E). Correctness notes (§observeTimestamp monotonic-max, per-lane watermarks) are load-bearing and asserted by Task 1(b) + Task 2(4).
- **Placeholder scan:** none — Task 1 carries the full new function body; Task 2's fixture-codegen step names the exact file set to match.
- **Type consistency:** `buildObjectStoreReplicaNode`'s new `numShards` field matches the writer node's shape; `bootLoaded`'s numShards derivation reads it via the same `?.numShards ?? 1` idiom. `laneConsumerId` is used identically at start and teardown (no start/stop id mismatch — the bug that would strand a watermark).
- **Byte-compat:** the `numShards === 1` branches in the new function reproduce today's exact behavior (bare consumerId, bare dataPath, single store, no composite) — Task 1 Step 7 gates it against the existing suites.
- **Review:** run the SDD per-task + whole-branch opus review if subagents are available (weekly limit was to reset 2026-03-12); else build solo with heavy tests + a post-hoc whole-branch review, and run the real-MinIO gate before claiming the S3-semantics half proven (the recurring arc lesson).
