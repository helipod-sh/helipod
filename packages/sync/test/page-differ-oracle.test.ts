/**
 * The differential ORACLE for the PAGE differ (§DLR 2c) — proves `rangeChangesFor` (2b's
 * CommitDiffer) is correct when the `RangeRead` it's fed is a pinned PAGE: a TWO-SIDED bound
 * `[start, end)` (a real lower AND a real upper key — the page's own fixed interval, minted once
 * at `paginate()` time via `pageReadFromDiffable`), not the one-sided/eq-prefix bound 2b's own
 * oracle (`range-differ-oracle.test.ts`) exercises. `rangeChangesFor` itself is shared between
 * 2b (range) and 2c (page) — the page case is just a `RangeRead` whose `bounds` happen to be
 * two-sided plus a `pageMeta` — so this file's whole job is to hammer the boundary-crossing and
 * out-of-bounds behavior that ONLY shows up once there's a real upper bound to cross:
 *
 *   - insert IN the page (grows it)
 *   - insert BELOW `start` and ABOVE `end` (both must be a no-op — never enter the page)
 *   - update-in-place (in bounds, no reorder)
 *   - update-move-within-bounds (reorder within the page)
 *   - update that CROSSES a bound (in -> out below/above, or out -> in) — the page-specific case
 *     2b's own oracle can't exercise, since its bound has no upper edge
 *   - update that crosses the `.where` filter
 *   - delete (in bounds)
 *
 * Same technique as 2b's oracle: an independent `oracleResult` recomputes the TRUE ordered page
 * result from scratch (filter via `evaluateFilter`, bounds-check + sort via
 * `extractIndexKey`/`keyInRange`/`compareKeyBytes` — the same primitives the query runtime uses,
 * never `commit-differ.ts`'s own `orderKeyFor`/internal bounds check) and a deterministically
 * seeded (mulberry32, NO `Math.random` — banned in this repo's tests) randomized op loop asserts
 * `sort(applyChanges(prevMap, changes)) === oracleResult(currentDocs, page)` after every single
 * op. If they ever disagree, the two-sided-bound path in `commit-differ.ts` is wrong — that
 * mismatch is exactly the guard this test exists to catch; the oracle itself must never be
 * weakened to make a failure go away.
 */
import { describe, it, expect } from "vitest";
import { rangeChangesFor, rangeResetChanges } from "../src/commit-differ";
import type { RowVersion } from "../src/change";
import type { RangeRead } from "../src/classify";
import type { WrittenDoc } from "@stackbase/transactor";
import type { JSONValue } from "@stackbase/values";
import type { DocumentValue } from "@stackbase/docstore";
import { evaluateFilter, extractIndexKey } from "@stackbase/query-engine";
import {
  compareKeyBytes,
  deserializeKeyRange,
  keyInRange,
  serializeKeyRange,
  encodeIndexKey,
  indexKeyspaceId,
} from "@stackbase/index-key-codec";

// -------------------------------------------------------------------------------------------
// The independent oracle (identical technique to 2b's — see range-differ-oracle.test.ts)
// -------------------------------------------------------------------------------------------

function fromBase64(b64: string): Uint8Array {
  return deserializeKeyRange({ keyspace: "", start: b64, end: null }).start;
}

/** The TRUE ordered PAGE result over `docs`, computed from scratch — a full re-scan, never via
 *  `rangeChangesFor`/incremental state: docs filtered by `.where` AND within `[start, end)`
 *  (byte-membership via `keyInRange`), sorted by `orderKey`. The independent ground truth the
 *  page differ's incremental diff+apply must always agree with. */
function oracleResult(docs: readonly JSONValue[], page: RangeRead): JSONValue[] {
  const bounds = deserializeKeyRange(page.bounds);
  const matches = docs.filter((d) => {
    const key = extractIndexKey(d as unknown as DocumentValue, page.fields);
    if (!keyInRange(key, bounds)) return false;
    return page.filters.every((f) => evaluateFilter(d as unknown as DocumentValue, f));
  });
  matches.sort((a, b) =>
    compareKeyBytes(
      extractIndexKey(a as unknown as DocumentValue, page.fields),
      extractIndexKey(b as unknown as DocumentValue, page.fields),
    ),
  );
  return matches;
}

// -------------------------------------------------------------------------------------------
// Deterministic PRNG (index/seed-derived — NO Math.random anywhere in this file)
// -------------------------------------------------------------------------------------------

/** mulberry32: a small, fully deterministic PRNG. Same seed => same sequence, forever. */
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
// The pinned page: a TWO-SIDED bound `[PAGE_START, PAGE_END)` over a single `priority` field —
// real boundary keys on both sides (not an eq-prefix like 2b's range), with a residual
// `.where("n", "gt", 3)` filter layered on top so filter-cross composes with bound-cross.
// -------------------------------------------------------------------------------------------

const KEYSPACE = indexKeyspaceId("3", "by_priority_page_oracle");
const PAGE_START = 5; // inclusive
const PAGE_END = 12; // exclusive — priority domain is [0, 18), so there's real room both
// below `start` (0..4) and above `end` (12..17) to exercise out-of-bounds inserts/crosses
// in both directions, plus a healthy in-bounds span (5..11) for moves.
const PRIORITY_DOMAIN = 18;

function makePage(): RangeRead {
  return {
    keyspace: KEYSPACE,
    bounds: serializeKeyRange({
      keyspace: KEYSPACE,
      start: encodeIndexKey([PAGE_START]),
      end: encodeIndexKey([PAGE_END]),
    }),
    filters: [{ op: "gt", field: "n", value: 3 }],
    order: "asc",
    fields: ["priority"],
    pageMeta: { nextCursor: null, hasMore: false, scanCapped: false },
  };
}

type OpKind =
  | "insert-in"
  | "insert-below"
  | "insert-above"
  | "update-in-place"
  | "update-move"
  | "update-bound-cross"
  | "update-filter-cross"
  | "delete";

const INSERT_KINDS: readonly OpKind[] = ["insert-in", "insert-below", "insert-above"];
const UPDATE_KINDS: readonly OpKind[] = [
  "update-in-place",
  "update-move",
  "update-bound-cross",
  "update-filter-cross",
  "delete",
];

const POOL_SIZE = 24;
const ITERATIONS_PER_SEED = 500;
const SEEDS = [1, 2, 3, 4, 5];

function inPageBounds(priority: number): boolean {
  return priority >= PAGE_START && priority < PAGE_END;
}

/** A random priority strictly OUTSIDE `[PAGE_START, PAGE_END)`, picking uniformly between the
 *  below-start and above-end sides so both out-of-bounds directions get exercised. */
function randOutOfBoundsPriority(rng: () => number): number {
  if (rng() < 0.5) return randInt(rng, PAGE_START); // [0, PAGE_START) — below start
  return PAGE_END + randInt(rng, PRIORITY_DOMAIN - PAGE_END); // [PAGE_END, domain) — above end
}

function randInBoundsPriority(rng: () => number): number {
  return PAGE_START + randInt(rng, PAGE_END - PAGE_START);
}

describe("page differ ORACLE (DLR 2c): diff+apply(sorted) === a fresh two-sided-bound oracle scan", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${ITERATIONS_PER_SEED} randomized ops always agree with the oracle`, () => {
      const page = makePage();
      const rng = mulberry32(seed);
      const ids = Array.from({ length: POOL_SIZE }, (_, i) => `docs|p${i}`);

      const currentDocs = new Map<string, JSONValue>(); // ground truth: docId -> current row (incl. out-of-page docs)
      let prevRowMap: Map<string, RowVersion> = rangeResetChanges(page, [], 0).next; // starts empty
      let ts = 1;
      let ctCounter = 1;

      for (let iter = 0; iter < ITERATIONS_PER_SEED; iter++) {
        const docId = ids[randInt(rng, ids.length)]!;
        const existed = currentDocs.has(docId);
        const kind: OpKind = existed
          ? UPDATE_KINDS[randInt(rng, UPDATE_KINDS.length)]!
          : INSERT_KINDS[randInt(rng, INSERT_KINDS.length)]!;
        const existing = currentDocs.get(docId) as Record<string, unknown> | undefined;

        let newRow: JSONValue | null;
        switch (kind) {
          case "insert-in": {
            const ct = ctCounter++;
            newRow = {
              _id: docId,
              priority: randInBoundsPriority(rng),
              n: randInt(rng, 7),
              tag: randInt(rng, 5),
              _creationTime: ct,
            };
            break;
          }
          case "insert-below":
          case "insert-above": {
            const ct = ctCounter++;
            newRow = {
              _id: docId,
              priority: randOutOfBoundsPriority(rng),
              n: randInt(rng, 7),
              tag: randInt(rng, 5),
              _creationTime: ct,
            };
            break;
          }
          case "update-in-place":
            // Touch an unrelated field only — no orderKey change, no filter change.
            newRow = { ...existing!, tag: randInt(rng, 5) };
            break;
          case "update-move":
            // Reorder within the CURRENT side of the bound (in-bounds docs stay in-bounds,
            // out-of-bounds docs stay out-of-bounds but may shuffle within their own side).
            newRow = {
              ...existing!,
              priority: inPageBounds(existing!["priority"] as number)
                ? randInBoundsPriority(rng)
                : randOutOfBoundsPriority(rng),
            };
            break;
          case "update-bound-cross":
            // The page-specific case: flip sides of EITHER bound, deterministically (never a
            // random re-roll that happens to land on the same side) so this op kind always
            // actually exercises a cross.
            newRow = {
              ...existing!,
              priority: inPageBounds(existing!["priority"] as number)
                ? randOutOfBoundsPriority(rng)
                : randInBoundsPriority(rng),
            };
            break;
          case "update-filter-cross": {
            const curN = existing!["n"] as number;
            // Deterministically flip sides of the `gt 3` threshold every time.
            newRow = { ...existing!, n: curN > 3 ? randInt(rng, 4) : 4 + randInt(rng, 3) };
            break;
          }
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

        const { next } = rangeChangesFor(page, prevRowMap, [wd]);
        prevRowMap = next;

        const sortedDiff = [...next.values()]
          .sort((a, b) => compareKeyBytes(fromBase64(a.orderKey!), fromBase64(b.orderKey!)))
          .map((v) => v.row);
        const oracle = oracleResult([...currentDocs.values()], page);

        expect(sortedDiff, `seed=${seed} iter=${iter} kind=${kind} docId=${docId}`).toEqual(oracle);
        // The diff's id set must also match the oracle's — a length/content check independent of
        // sort order, catching a differ bug that happens to preserve order by accident.
        expect(next.size, `seed=${seed} iter=${iter} kind=${kind} docId=${docId} (map size)`).toBe(oracle.length);
      }
    });
  }
});
