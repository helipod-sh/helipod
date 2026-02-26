/**
 * `stackbase objectstore <subcommand>` — object-storage maintenance tools.
 *
 * `objectstore reshard --object-store <url> --dir <convex> --shards M` changes a STOPPED
 * object-storage deployment's shard count N→M: it loads the schema (for each table's shard key),
 * dynamic-imports + gates `@stackbase/objectstore-substrate`, and runs `reshardObjectStore` — which
 * physically re-partitions every doc's current state to `shardIdForKeyValue(doc[shardKey], M)`'s lane
 * (see that function's doc for the offline, non-atomic, back-up-first contract). Errors — a live
 * deployment, a bad URL, missing args — surface as a clean `✗ <message>` + exit 1.
 */
import { dirname } from "node:path";
import { resolveObjectStore } from "./objectstore-select";
import { loadObjectStoreSubstrateModule, makeInMemorySqliteStore } from "./boot";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";

export async function objectstoreCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "reshard") {
    process.stderr.write(
      `✗ unknown \`objectstore\` subcommand '${sub ?? ""}' — usage: ` +
        `stackbase objectstore reshard --object-store <url> --dir <convex> --shards M\n`,
    );
    return 1;
  }
  return reshardCommand(args.slice(1));
}

async function reshardCommand(args: string[]): Promise<number> {
  let objectStoreUrl = process.env.STACKBASE_OBJECT_STORE;
  let dir = "convex";
  let shards: number | undefined;
  const VALUE_FLAGS = new Set(["--object-store", "--dir", "--shards"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!VALUE_FLAGS.has(a)) continue;
    // A recognized flag must be followed by a value — a trailing `--dir` with no value is an error,
    // not a silent fall-through to the default (which would misroute an operator who fat-fingered it).
    const val = args[i + 1];
    if (val === undefined) {
      process.stderr.write(`✗ ${a} requires a value.\n`);
      return 1;
    }
    i++;
    if (a === "--object-store") objectStoreUrl = val;
    else if (a === "--dir") dir = val;
    else shards = Number(val);
  }
  if (!objectStoreUrl) {
    process.stderr.write("✗ objectstore reshard requires --object-store <url> (or STACKBASE_OBJECT_STORE).\n");
    return 1;
  }
  if (shards === undefined || !Number.isInteger(shards) || shards < 1) {
    process.stderr.write("✗ objectstore reshard requires --shards <M> (a positive integer).\n");
    return 1;
  }
  try {
    const resolved = resolveObjectStore(objectStoreUrl); // may throw on an unsupported scheme → clean ✗ below
    if (resolved === null) {
      process.stderr.write(`✗ --object-store "${objectStoreUrl}" did not resolve to a store (empty/unset value?).\n`);
      return 1;
    }

    // The reshard's ONLY schema dependency: the per-table shard key. Load the app's convex dir the same
    // way `bootProject` does, and read `.shardKey` off the composed catalog.
    const loaded = await loadConvexDir(dir);
    const config = await loadConfig(dirname(dir));
    const { project } = push(loaded, config.components);
    const shardKeyFor = (tableNumber: number): string | null =>
      project.catalog.getTableByNumber(tableNumber)?.shardKey ?? null;

    const substrate = await loadObjectStoreSubstrateModule();
    await resolved.objectStore.assertCasSupported();

    const result = await substrate.reshardObjectStore({
      objectStore: resolved.objectStore,
      toShards: shards,
      now: Date.now(),
      shardKeyFor,
      makeLocal: makeInMemorySqliteStore,
    });

    if (result.fromShards === result.toShards) {
      process.stdout.write(`✓ bucket is already at ${result.toShards} shard(s) — nothing to do.\n`);
      return 0;
    }
    const perLane = Object.entries(result.perLaneCounts)
      .map(([lane, n]) => `${lane}=${n}`)
      .join(", ");
    process.stdout.write(
      `✓ resharded ${result.fromShards} → ${result.toShards} shard(s) ` +
        `(moved ${result.movedDocs} doc(s); per-lane: ${perLane}). ` +
        `A node booting this bucket now uses ${result.toShards} shard(s) — set --shards ${result.toShards} ` +
        `(or STACKBASE_FLEET_SHARDS), or drop it (the bucket's persisted count is authoritative).\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
