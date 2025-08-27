/**
 * `QueryRuntime` executes a query against the `DocStore` and records the read set.
 *
 * `collect` scans the whole planned interval; `paginate` resumes from an opaque cursor and
 * returns one page. Both record the exact byte span they consumed as a `RangeSet` (in the
 * index keyspace) — the read set the transactor validates and the sync tier matches writes
 * against. Pagination is stable under concurrent head inserts because the cursor pins a key
 * position and index keys are unique (they end in `_id`).
 */
import {
  RangeSet,
  compareKeyBytes,
  indexKeyspaceId,
  keySuccessor,
  type KeyRange,
} from "@stackbase/index-key-codec";
import { encodeStorageTableId } from "@stackbase/id-codec";
import type { DocStore, DocumentValue, IndexOverlayEntry } from "@stackbase/docstore";
import { buildIndexInterval, type IndexInterval, type RangeExpression, type ScanOrder } from "./plan";
import { evaluateFilter, type FilterExpr } from "./filter";
import type { IndexSpec } from "./index-manager";

export interface Query {
  index: IndexSpec;
  range?: RangeExpression[];
  order?: ScanOrder;
  filters?: FilterExpr[];
  limit?: number;
}

export interface CollectResult {
  documents: DocumentValue[];
  readSet: RangeSet;
}

export interface PaginatedResult {
  page: DocumentValue[];
  nextCursor: string | null;
  hasMore: boolean;
  scanCapped: boolean;
  readSet: RangeSet;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Stable string form of index-key bytes, for keying the overlay merge map. */
function hexKey(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

/** Whether `key` falls in the half-open interval `[start, end)` (a null `end` is +∞). */
function keyInInterval(key: Uint8Array, interval: IndexInterval): boolean {
  return (
    compareKeyBytes(key, interval.start) >= 0 &&
    (interval.end === null || compareKeyBytes(key, interval.end) < 0)
  );
}

export class QueryRuntime {
  constructor(private readonly docStore: DocStore) {}

  private keyspace(index: IndexSpec): string {
    // Keyspaces are keyed by the storage table id (number) so query read ranges and the
    // transactor's write ranges share one table identity for invalidation matching.
    return indexKeyspaceId(encodeStorageTableId(index.tableNumber), index.index);
  }

  async collect(
    query: Query,
    readTimestamp: bigint,
    overlay?: readonly IndexOverlayEntry[],
  ): Promise<CollectResult> {
    const order = query.order ?? "asc";
    const filters = query.filters ?? [];
    const interval = buildIndexInterval(query.index.fields, query.range ?? []);
    const tableId = encodeStorageTableId(query.index.tableNumber);

    // Read-your-own-writes: when the calling transaction has pending writes touching this index,
    // overlay them so `.query()` reflects the transaction's own inserts/updates/deletes — the same
    // guarantee `ctx.db.get()` already provides. This path runs only inside a mutation (a query or
    // client subscription has no staged writes → empty overlay → the fast path below, unchanged).
    if (overlay && overlay.length > 0) {
      const merged = await this.scanWithOverlay(query, readTimestamp, interval, order, overlay);
      const documents: DocumentValue[] = [];
      for (const { value } of merged) {
        if (filters.every((f) => evaluateFilter(value, f))) {
          documents.push(value);
          if (query.limit !== undefined && documents.length >= query.limit) break;
        }
      }
      // The overlay path scans the whole interval, so the read set is the full interval (broader
      // than the trimmed fast path, but this only feeds OCC validation inside a mutation).
      const overlayReadSet = new RangeSet();
      overlayReadSet.add({ keyspace: this.keyspace(query.index), start: interval.start, end: interval.end });
      return { documents, readSet: overlayReadSet };
    }

    const readSet = new RangeSet();
    const documents: DocumentValue[] = [];
    let lastScanned: Uint8Array | null = null;
    let hitLimit = false;

    for await (const [key, doc] of this.docStore.index_scan(
      query.index.indexId,
      tableId,
      readTimestamp,
      interval,
      order,
    )) {
      lastScanned = key;
      const value = doc.value.value;
      if (filters.every((f) => evaluateFilter(value, f))) {
        documents.push(value);
        if (query.limit !== undefined && documents.length >= query.limit) { hitLimit = true; break; }
      }
    }

    // For a no-limit (or limit-not-reached) collect, record the FULL scan interval as the read
    // range so that any insertion anywhere in the range (including beyond the last result) correctly
    // triggers reactive re-evaluation. Only trim to successor(lastKey) when the limit was reached
    // (the scan stopped early — keys beyond lastKey were not read).
    const scanRange = hitLimit
      ? this.consumedRange(query.index, interval, order, lastScanned)
      : { keyspace: this.keyspace(query.index), start: interval.start, end: interval.end };
    readSet.add(scanRange);
    return { documents, readSet };
  }

  async paginate(
    query: Query,
    readTimestamp: bigint,
    opts: { cursor?: string | null; pageSize: number; maxScan?: number },
    overlay?: readonly IndexOverlayEntry[],
  ): Promise<PaginatedResult> {
    const order = query.order ?? "asc";
    const filters = query.filters ?? [];
    const base = buildIndexInterval(query.index.fields, query.range ?? []);
    const tableId = encodeStorageTableId(query.index.tableNumber);

    // Resume from the cursor: keys strictly after it (asc) or strictly before it (desc).
    let interval: IndexInterval = base;
    if (opts.cursor) {
      const k = base64ToBytes(opts.cursor);
      interval = order === "asc" ? { start: keySuccessor(k), end: base.end } : { start: base.start, end: k };
    }

    // Read-your-own-writes overlay (see `collect`). `maxScan`/`scanCapped` don't apply here — the
    // overlay path scans the whole remaining interval to merge staged writes, and runs only inside a
    // mutation paginating over data it just wrote.
    if (overlay && overlay.length > 0) {
      const merged = await this.scanWithOverlay(query, readTimestamp, interval, order, overlay);
      const matched = merged.filter((e) => filters.every((f) => evaluateFilter(e.value, f)));
      const pageEntries = matched.slice(0, opts.pageSize);
      const hasMoreOverlay = matched.length > opts.pageSize;
      const lastKey = hasMoreOverlay ? pageEntries[pageEntries.length - 1]!.key : null;
      const overlayReadSet = new RangeSet();
      overlayReadSet.add({ keyspace: this.keyspace(query.index), start: interval.start, end: interval.end });
      return {
        page: pageEntries.map((e) => e.value),
        nextCursor: lastKey ? bytesToBase64(lastKey) : null,
        hasMore: hasMoreOverlay,
        scanCapped: false,
        readSet: overlayReadSet,
      };
    }

    const page: DocumentValue[] = [];
    let lastIncluded: Uint8Array | null = null;
    let lastScanned: Uint8Array | null = null;
    let hasMore = false;
    let scanned = 0;
    let scanCapped = false;

    for await (const [key, doc] of this.docStore.index_scan(query.index.indexId, tableId, readTimestamp, interval, order)) {
      lastScanned = key;
      const value = doc.value.value;
      if (filters.every((f) => evaluateFilter(value, f))) {
        if (page.length >= opts.pageSize) { hasMore = true; break; }
        page.push(value);
        lastIncluded = key;
      }
      scanned++;
      if (opts.maxScan !== undefined && scanned >= opts.maxScan) {
        hasMore = true;                       // stopped early — there may be more
        if (page.length < opts.pageSize) scanCapped = true;
        break;
      }
    }

    const readSet = new RangeSet();
    // When the scan completed without hitting a page or scan cap (hasMore = false, scanCapped = false),
    // record the FULL remaining interval as the read range — identical to the `collect` strategy —
    // so that any insertion beyond the last result still triggers reactive re-evaluation.
    // Only trim to successor(lastScanned) when we stopped early (hasMore=true or scanCapped=true).
    const fullInterval = !hasMore && !scanCapped;
    readSet.add(
      fullInterval
        ? { keyspace: this.keyspace(query.index), start: interval.start, end: interval.end }
        : this.consumedRange(query.index, interval, order, lastScanned),
    );
    // When capped, resume past where we STOPPED scanning (lastScanned), not the last returned row.
    const cursorKey = scanCapped ? lastScanned : hasMore ? lastIncluded : null;
    const nextCursor = cursorKey ? bytesToBase64(cursorKey) : null;
    return { page, nextCursor, hasMore, scanCapped, readSet };
  }

  /**
   * Full-interval index scan merged with the transaction's staged writes: committed rows are
   * overlaid key-by-key with pending inserts/updates (a non-null overlay value adds or replaces the
   * row at that key) and deletes (a null overlay value removes the key), then re-sorted in scan
   * order. Returns `{ key, value }` so callers can page by key. Only invoked when `overlay` is
   * non-empty — i.e. inside a mutation with pending writes to this index.
   */
  private async scanWithOverlay(
    query: Query,
    readTimestamp: bigint,
    interval: IndexInterval,
    order: ScanOrder,
    overlay: readonly IndexOverlayEntry[],
  ): Promise<Array<{ key: Uint8Array; value: DocumentValue }>> {
    const tableId = encodeStorageTableId(query.index.tableNumber);
    const merged = new Map<string, { key: Uint8Array; value: DocumentValue }>();
    for await (const [key, doc] of this.docStore.index_scan(
      query.index.indexId,
      tableId,
      readTimestamp,
      interval,
      order,
    )) {
      merged.set(hexKey(key), { key, value: doc.value.value });
    }
    for (const o of overlay) {
      const h = hexKey(o.key);
      if (o.value === null) {
        merged.delete(h); // staged delete (or the old key of a row whose indexed field moved)
      } else if (keyInInterval(o.key, interval)) {
        merged.set(h, { key: o.key, value: o.value }); // staged insert/update within range
      }
    }
    const entries = [...merged.values()];
    entries.sort((a, b) => (order === "asc" ? compareKeyBytes(a.key, b.key) : compareKeyBytes(b.key, a.key)));
    return entries;
  }

  /** The byte span actually read (so reactive invalidation isn't broader than necessary). */
  private consumedRange(
    index: IndexSpec,
    interval: IndexInterval,
    order: ScanOrder,
    lastScanned: Uint8Array | null,
  ): KeyRange {
    const keyspace = this.keyspace(index);
    if (lastScanned === null) return { keyspace, start: interval.start, end: interval.end };
    return order === "asc"
      ? { keyspace, start: interval.start, end: keySuccessor(lastScanned) }
      : { keyspace, start: lastScanned, end: interval.end };
  }
}
