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
  indexKeyspaceId,
  keySuccessor,
  type KeyRange,
} from "@stackbase/index-key-codec";
import { encodeStorageTableId } from "@stackbase/id-codec";
import type { DocStore, DocumentValue } from "@stackbase/docstore";
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

export class QueryRuntime {
  constructor(private readonly docStore: DocStore) {}

  private keyspace(index: IndexSpec): string {
    // Keyspaces are keyed by the storage table id (number) so query read ranges and the
    // transactor's write ranges share one table identity for invalidation matching.
    return indexKeyspaceId(encodeStorageTableId(index.tableNumber), index.index);
  }

  async collect(query: Query, readTimestamp: bigint): Promise<CollectResult> {
    const order = query.order ?? "asc";
    const filters = query.filters ?? [];
    const interval = buildIndexInterval(query.index.fields, query.range ?? []);
    const tableId = encodeStorageTableId(query.index.tableNumber);

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
    readSet.add(this.consumedRange(query.index, interval, order, lastScanned));
    // When capped, resume past where we STOPPED scanning (lastScanned), not the last returned row.
    const cursorKey = scanCapped ? lastScanned : hasMore ? lastIncluded : null;
    const nextCursor = cursorKey ? bytesToBase64(cursorKey) : null;
    return { page, nextCursor, hasMore, scanCapped, readSet };
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
