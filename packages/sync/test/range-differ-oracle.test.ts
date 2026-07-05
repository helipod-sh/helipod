/**
 * The differential ORACLE for `rangeChangesFor` (DLR 2b) — the primary correctness net for the
 * range CommitDiffer. An independent `oracleResult` recomputes the TRUE ordered range result from
 * scratch (filter via `evaluateFilter`, bounds-check + sort via `extractIndexKey`/`compareKeyBytes`
 * — the SAME primitives the query runtime/executor use, but NOT going through `commit-differ.ts`'s
 * own `orderKeyFor`/internal bounds check). A deterministically-seeded randomized loop (no
 * `Math.random` anywhere — banned) applies a sequence of insert/update(-in-place/-move/
 * -filter-cross/-channel-cross)/delete ops to a pool of docs, diffing each one incrementally via
 * `rangeChangesFor`, and asserts that `applyChanges`'d-and-sorted diff state equals a fresh
 * `oracleResult` over the CURRENT (post-op) doc set. If they ever disagree, `orderKeyFor`/
 * `inBounds`/the membership logic in `commit-differ.ts` is wrong — that mismatch is the guard this
 * test exists to catch; the oracle itself must never be weakened to make a failure go away.
 */
import { describe, it, expect } from "vitest";
import { rangeChangesFor, rangeResetChanges } from "../src/commit-differ";
import type { RowVersion } from "../src/change";
import type { RangeRead } from "../src/classify";
import type { WrittenDoc } from "@helipod/transactor";
import type { JSONValue } from "@helipod/values";
import type { DocumentValue } from "@helipod/docstore";
import { evaluateFilter, extractIndexKey } from "@helipod/query-engine";
import {
  compareKeyBytes,
  deserializeKeyRange,
  keyInRange,
  serializeKeyRange,
  indexKeyRangeStart,
  indexKeyRangeEnd,
  indexKeyspaceId,
} from "@helipod/index-key-codec";

// -------------------------------------------------------------------------------------------
// The independent oracle
// -------------------------------------------------------------------------------------------

/** Decode a `RowVersion.orderKey` (base64, minted by `orderKeyFor`) back to raw bytes. Reuses
 *  `deserializeKeyRange` (the SAME codec `SerializedKeyRange.start` uses, via a throwaway
 *  keyspace) rather than a second `atob` implementation — deliberately the same technique
 *  `commit-differ.ts`'s own (unexported) `fromBase64` uses, so the oracle decodes exactly what
 *  the differ encoded. */
function fromBase64(b64: string): Uint8Array {
  return deserializeKeyRange({ keyspace: "", start: b64, end: null }).start;
}

/** The TRUE ordered range result over `docs`, computed from scratch — a full re-scan, never via
 *  `rangeChangesFor`/incremental state. Filters via `evaluateFilter` (same as the query runtime),
 *  bounds-checks + sorts via `extractIndexKey`/`keyInRange`/`compareKeyBytes` (same as the
 *  executor's own index scans) — the independent ground truth `rangeChangesFor`'s incremental
 *  diff+apply must always agree with. */
function oracleResult(docs: readonly JSONValue[], range: RangeRead): JSONValue[] {
  const bounds = deserializeKeyRange(range.bounds);
  const matches = docs.filter((d) => {
    const key = extractIndexKey(d as unknown as DocumentValue, range.fields);
    if (!keyInRange(key, bounds)) return false;
    return range.filters.every((f) => evaluateFilter(d as unknown as DocumentValue, f));
  });
  matches.sort((a, b) =>
    compareKeyBytes(
      extractIndexKey(a as unknown as DocumentValue, range.fields),
      extractIndexKey(b as unknown as DocumentValue, range.fields),
    ),
  );
  return matches;
}

// -------------------------------------------------------------------------------------------
// Deterministic PRNG (index/seed-derived — NO Math.random anywhere in this file)
// -------------------------------------------------------------------------------------------

/** mulberry32: a small, fully deterministic PRNG. Same seed => same sequence, forever — the
 *  opposite of `Math.random`, which this repo bans from tests for exactly this reason. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

// -------------------------------------------------------------------------------------------
// The randomized loop
// -------------------------------------------------------------------------------------------

const KEYSPACE = indexKeyspaceId("3", "by_channel_priority_oracle");

/** A 2-field index (channelId, priority), bounded to `channelId = "c"` (an eq prefix, so
 *  `update-move` can reorder within bounds), with a `.where("n", "gt", 3)` residual filter (so
 *  `update-filter-cross` exercises cross-in/cross-out). `update-channel-cross` additionally
 *  exercises the bounds check itself (leaving/entering the "c" prefix), beyond just the filter. */
function makeRange(): RangeRead {
  return {
    keyspace: KEYSPACE,
    bounds: serializeKeyRange({
      keyspace: KEYSPACE,
      start: indexKeyRangeStart(["c"]),
      end: indexKeyRangeEnd(["c"])!, // non-empty prefix => never null
    }),
    filters: [{ op: "gt", field: "n", value: 3 }],
    order: "asc",
    fields: ["channelId", "priority"],
  };
}

type OpKind = "insert" | "update-in-place" | "update-move" | "update-filter-cross" | "update-channel-cross" | "delete";
const UPDATE_KINDS: readonly OpKind[] = ["update-in-place", "update-move", "update-filter-cross", "update-channel-cross", "delete"];

const POOL_SIZE = 24;
const ITERATIONS_PER_SEED = 150;
const SEEDS = [1, 2, 3, 4, 5, 6];

describe("range differ ORACLE (DLR 2b): diff+apply(sorted) === a fresh oracleResult scan", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${ITERATIONS_PER_SEED} randomized ops always agree with the oracle`, () => {
      const range = makeRange();
      const rng = mulberry32(seed);
      const ids = Array.from({ length: POOL_SIZE }, (_, i) => `docs|p${i}`);

      const currentDocs = new Map<string, JSONValue>(); // ground truth: docId -> current row
      let prevRowMap: Map<string, RowVersion> = rangeResetChanges(range, [], 0).next; // starts empty
      let ts = 1;
      let ctCounter = 1;

      for (let iter = 0; iter < ITERATIONS_PER_SEED; iter++) {
        const docId = ids[randInt(rng, ids.length)]!;
        const existed = currentDocs.has(docId);
        const kind: OpKind = existed ? UPDATE_KINDS[randInt(rng, UPDATE_KINDS.length)]! : "insert";
        const existing = currentDocs.get(docId) as Record<string, unknown> | undefined;

        let newRow: JSONValue | null;
        switch (kind) {
          case "insert": {
            const ct = ctCounter++;
            newRow = {
              _id: docId,
              channelId: rng() < 0.7 ? "c" : "other", // weighted toward in-range so the range is non-trivial
              priority: randInt(rng, 10),
              n: randInt(rng, 7),
              _creationTime: ct,
            };
            break;
          }
          case "update-in-place":
            newRow = { ...existing!, n: randInt(rng, 7) };
            break;
          case "update-move":
            newRow = { ...existing!, priority: randInt(rng, 10) };
            break;
          case "update-filter-cross": {
            const curN = existing!["n"] as number;
            // Deterministically flip sides of the `gt 3` threshold every time — guarantees this
            // op kind actually exercises a cross, not just an occasional random re-roll.
            newRow = { ...existing!, n: curN > 3 ? randInt(rng, 4) : 4 + randInt(rng, 3) };
            break;
          }
          case "update-channel-cross":
            newRow = { ...existing!, channelId: existing!["channelId"] === "c" ? "other" : "c" };
            break;
          case "delete":
            newRow = null;
            break;
        }

        if (newRow === null) currentDocs.delete(docId);
        else currentDocs.set(docId, newRow);

        const wd: WrittenDoc = {
          key: "x",
          keyspace: "table:3",
          docId,
          newRow: newRow as never,
          wasPresent: existed,
          ts: ts++,
        };

        const { next } = rangeChangesFor(range, prevRowMap, [wd]);
        prevRowMap = next;

        const sortedDiff = [...next.values()]
          .sort((a, b) => compareKeyBytes(fromBase64(a.orderKey!), fromBase64(b.orderKey!)))
          .map((v) => v.row);
        const oracle = oracleResult([...currentDocs.values()], range);

        expect(sortedDiff, `seed=${seed} iter=${iter} kind=${kind} docId=${docId}`).toEqual(oracle);
        // The diff's id set must also match the oracle's — a length/content check independent of
        // sort order, catching a differ bug that happens to preserve order by accident.
        expect(next.size, `seed=${seed} iter=${iter} kind=${kind} docId=${docId} (map size)`).toBe(oracle.length);
      }
    });
  }
});
