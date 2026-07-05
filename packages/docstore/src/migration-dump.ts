/**
 * The portable **migration dump** — the wire format + codec + export/import primitives that move an
 * app's DATA between physical storage topologies (container + R2 object-store / plain SQLite /
 * Postgres ⇄ Cloudflare DO-SQLite). Slice 5 of the DO-native host program
 * (`docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md`).
 *
 * ## Why this is possible at all
 * Every store — SQLite, Postgres, R2 object-store, DO-SQLite — persists the SAME logical shape: the
 * append-only MVCC document log `{ts, id, value, prev_ts}` plus a parallel MVCC index log. A dump is
 * simply that store's CURRENT materialized state (every live document's latest revision + every
 * current index row) — exactly `SqliteDocStore.dumpCurrentState()`'s output. So this reuses that
 * primitive rather than inventing a new one; it is the same shape the Tier-3 R2 snapshot mechanism
 * (`ee/objectstore-substrate/snapshot.ts`) already round-trips.
 *
 * ## The wire tagging
 * JSON has no native `bigint`/`Uint8Array`, so the wire form tags them (the SAME convention
 * `segment.ts` proved, reimplemented here because core cannot depend on the `ee/` package):
 *   - `bigint` (ts/prev_ts)              → decimal string
 *   - `Uint8Array` (id bytes, index keys) → base64
 *   - a document's field `Value`s         → `@helipod/values`' `convexToJson`/`jsonToConvex`
 *
 * ## The table-number collision guard (THE load-bearing check)
 * A document's physical `table_id` IS its table number; the number→name mapping lives only in the
 * runtime's schema, never in the store, and two independent deploys of the same `schema.ts` can
 * assign DIFFERENT numbers. So the dump carries `tableNumbers` and {@link assertImportableTableNumbers}
 * REFUSES an import whose numbers don't match the target — otherwise a dump's rows would be served
 * under the WRONG table (the object-store table-number-clash bug this program already hit).
 */
import { convexToJson, jsonToConvex, type JSONValue } from "@helipod/values";
import type {
  ConflictStrategy,
  DatabaseIndexUpdate,
  DatabaseIndexValue,
  DocumentLogEntry,
  IndexWrite,
  InternalDocumentId,
  ResolvedDocument,
  ShardId,
} from "./types";

/* --- base64 (portable: global btoa/atob, no Node Buffer — matches @helipod/values' json.ts) --- */

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

/* --- wire (JSON-safe) shapes --- */

interface WireInternalDocumentId {
  tableNumber: number;
  internalId: string; // base64
}
interface WireResolvedDocument {
  id: WireInternalDocumentId;
  value: JSONValue;
}
export interface WireDocumentLogEntry {
  ts: string; // decimal bigint
  id: WireInternalDocumentId;
  value: WireResolvedDocument | null; // null = tombstone (never present in a dump — see below)
  prev_ts: string | null;
}
type WireDatabaseIndexValue = { type: "Deleted" } | { type: "NonClustered"; docId: WireInternalDocumentId };
interface WireDatabaseIndexUpdate {
  indexId: string;
  key: string; // base64
  value: WireDatabaseIndexValue;
}
export interface WireIndexWrite {
  ts: string;
  update: WireDatabaseIndexUpdate;
}

/** The current dump format version. Bumped only on a breaking wire change. */
export const MIGRATION_DUMP_FORMAT = "helipod-migration-dump";
export const MIGRATION_DUMP_VERSION = 1;

/**
 * A portable, point-in-time image of an app's full materialized state, plus the table-number map that
 * makes it safe to import. `documents`/`indexUpdates` are `dumpCurrentState()`'s output, wire-encoded.
 */
export interface MigrationDump {
  format: typeof MIGRATION_DUMP_FORMAT;
  version: number;
  /** The SOURCE deployment id — METADATA ONLY (never applied; applying it would flip outbox clients
   *  to `known:false`). Present for provenance/debugging. */
  deploymentId: string | null;
  /** `fullTableName → tableNumber`, from the source runtime's schema. THE collision guard's input. */
  tableNumbers: Record<string, number>;
  /** The source `store.maxTimestamp()` at export (decimal bigint). */
  frontierTs: string;
  documents: WireDocumentLogEntry[];
  indexUpdates: WireIndexWrite[];
}

/* --- per-row codec --- */

function encodeId(id: InternalDocumentId): WireInternalDocumentId {
  return { tableNumber: id.tableNumber, internalId: bytesToBase64(id.internalId) };
}
function decodeId(id: WireInternalDocumentId): InternalDocumentId {
  return { tableNumber: id.tableNumber, internalId: base64ToBytes(id.internalId) };
}
function encodeDoc(doc: ResolvedDocument): WireResolvedDocument {
  return { id: encodeId(doc.id), value: convexToJson(doc.value) };
}
function decodeDoc(doc: WireResolvedDocument): ResolvedDocument {
  return { id: decodeId(doc.id), value: jsonToConvex(doc.value) as ResolvedDocument["value"] };
}
function encodeDocEntry(e: DocumentLogEntry): WireDocumentLogEntry {
  return {
    ts: e.ts.toString(),
    id: encodeId(e.id),
    value: e.value === null ? null : encodeDoc(e.value),
    prev_ts: e.prev_ts === null ? null : e.prev_ts.toString(),
  };
}
function decodeDocEntry(e: WireDocumentLogEntry): DocumentLogEntry {
  return {
    ts: BigInt(e.ts),
    id: decodeId(e.id),
    value: e.value === null ? null : decodeDoc(e.value),
    prev_ts: e.prev_ts === null ? null : BigInt(e.prev_ts),
  };
}
function encodeIdxValue(v: DatabaseIndexValue): WireDatabaseIndexValue {
  return v.type === "Deleted" ? { type: "Deleted" } : { type: "NonClustered", docId: encodeId(v.docId) };
}
function decodeIdxValue(v: WireDatabaseIndexValue): DatabaseIndexValue {
  return v.type === "Deleted" ? { type: "Deleted" } : { type: "NonClustered", docId: decodeId(v.docId) };
}
function encodeIdxUpdate(u: DatabaseIndexUpdate): WireDatabaseIndexUpdate {
  return { indexId: u.indexId, key: bytesToBase64(u.key), value: encodeIdxValue(u.value) };
}
function decodeIdxUpdate(u: WireDatabaseIndexUpdate): DatabaseIndexUpdate {
  return { indexId: u.indexId, key: base64ToBytes(u.key), value: decodeIdxValue(u.value) };
}
function encodeIdxWrite(w: IndexWrite): WireIndexWrite {
  return { ts: w.ts.toString(), update: encodeIdxUpdate(w.update) };
}
function decodeIdxWrite(w: WireIndexWrite): IndexWrite {
  return { ts: BigInt(w.ts), update: decodeIdxUpdate(w.update) };
}

/* --- capability + errors --- */

/** The narrow store capability a dump export needs (a superset of `DocStore` — `SqliteDocStore` has
 *  it natively; the R2 `ObjectStoreDocStore` and `PostgresDocStore` add a delegating/mirroring
 *  implementation). Kept structural so this module depends on no concrete store. */
export interface DumpableDocStore {
  dumpCurrentState(): Promise<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }>;
  maxTimestamp(): Promise<bigint>;
}

/** The minimal write surface an import target needs — a strict subset of `DocStore`. */
export interface ImportableDocStore {
  write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void>;
}

/** Thrown when a source store cannot produce a dump (no `dumpCurrentState`). */
export class DumpUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpUnsupportedError";
  }
}

/** Thrown when a dump is malformed / wrong format / wrong version. */
export class InvalidDumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDumpError";
  }
}

/** Thrown by the collision guard when the dump's table numbers are incompatible with the target — the
 *  refusal that prevents a dump's rows from ever being served under the wrong table. */
export class TableNumberMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableNumberMismatchError";
  }
}

/* --- export --- */

export interface ExportDumpMeta {
  /** The source runtime's `fullTableName → tableNumber` map (the collision guard's payload). */
  tableNumbers: Record<string, number>;
  /** Optional source deployment id (metadata only). */
  deploymentId?: string | null;
}

/** True iff `store` can produce a dump. */
export function isDumpable(store: unknown): store is DumpableDocStore {
  return (
    typeof (store as DumpableDocStore | null)?.dumpCurrentState === "function" &&
    typeof (store as DumpableDocStore | null)?.maxTimestamp === "function"
  );
}

/** Export a store's full current materialized state to a portable {@link MigrationDump}. */
export async function exportDumpFromStore(store: unknown, meta: ExportDumpMeta): Promise<MigrationDump> {
  if (!isDumpable(store)) {
    throw new DumpUnsupportedError(
      "this store cannot be exported: it does not implement dumpCurrentState()/maxTimestamp() " +
        "(migration export requires a SQLite/DO-SQLite/object-store/Postgres store)",
    );
  }
  const [state, frontierTs] = await Promise.all([store.dumpCurrentState(), store.maxTimestamp()]);
  return {
    format: MIGRATION_DUMP_FORMAT,
    version: MIGRATION_DUMP_VERSION,
    deploymentId: meta.deploymentId ?? null,
    tableNumbers: { ...meta.tableNumbers },
    frontierTs: frontierTs.toString(),
    documents: state.documents.map(encodeDocEntry),
    indexUpdates: state.indexUpdates.map(encodeIdxWrite),
  };
}

/** Serialize a dump to a JSON string (for a file or an HTTP body). */
export function serializeDump(dump: MigrationDump): string {
  return JSON.stringify(dump);
}

/** Parse + validate a dump from JSON. Throws {@link InvalidDumpError} on a bad shape/version. */
export function parseDump(json: string | unknown): MigrationDump {
  const raw = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  const d = raw as Partial<MigrationDump> | null;
  if (!d || typeof d !== "object") throw new InvalidDumpError("dump is not an object");
  if (d.format !== MIGRATION_DUMP_FORMAT) throw new InvalidDumpError(`not a ${MIGRATION_DUMP_FORMAT} (format=${String(d.format)})`);
  if (d.version !== MIGRATION_DUMP_VERSION) {
    throw new InvalidDumpError(`unsupported dump version ${String(d.version)} (this build handles ${MIGRATION_DUMP_VERSION})`);
  }
  if (typeof d.tableNumbers !== "object" || d.tableNumbers === null) throw new InvalidDumpError("dump.tableNumbers missing");
  if (!Array.isArray(d.documents) || !Array.isArray(d.indexUpdates)) throw new InvalidDumpError("dump.documents/indexUpdates missing");
  if (typeof d.frontierTs !== "string") throw new InvalidDumpError("dump.frontierTs missing");
  return d as MigrationDump;
}

/** Decode a dump's rows back to engine `DocumentLogEntry`/`IndexWrite`. */
export function decodeDumpRows(dump: MigrationDump): { documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] } {
  return { documents: dump.documents.map(decodeDocEntry), indexUpdates: dump.indexUpdates.map(decodeIdxWrite) };
}

/* --- the collision guard --- */

/** The set of table numbers a dump's rows actually touch (documents + index docId pointers). */
function tableNumbersInDump(dump: MigrationDump): Set<number> {
  const used = new Set<number>();
  for (const d of dump.documents) used.add(d.id.tableNumber);
  for (const i of dump.indexUpdates) {
    if (i.update.value.type === "NonClustered") used.add(i.update.value.docId.tableNumber);
  }
  return used;
}

/**
 * REFUSE an import whose table numbers are incompatible with the target — the guard that stops a
 * dump's rows from being served under the wrong table. For every table number the dump's rows
 * actually use: resolve its name via the DUMP's own `tableNumbers`, then require the TARGET to map
 * that same name to that same number. Rejects a dump-internal inconsistency, a table missing from the
 * target, or a differing number.
 */
export function assertImportableTableNumbers(dump: MigrationDump, targetTableNumbers: Record<string, number>): void {
  const dumpNumberToName = new Map<number, string>();
  for (const [name, num] of Object.entries(dump.tableNumbers)) dumpNumberToName.set(num, name);

  for (const n of tableNumbersInDump(dump)) {
    const name = dumpNumberToName.get(n);
    if (name === undefined) {
      throw new TableNumberMismatchError(
        `corrupt dump: rows reference table number ${n} that is absent from the dump's own tableNumbers map`,
      );
    }
    const targetN = targetTableNumbers[name];
    if (targetN === undefined) {
      throw new TableNumberMismatchError(
        `cannot import: the target deployment has no table "${name}" (deploy the matching schema before importing)`,
      );
    }
    if (targetN !== n) {
      throw new TableNumberMismatchError(
        `cannot import: table "${name}" is number ${n} in the dump but ${targetN} in the target — importing would ` +
          `serve the dump's rows under the wrong table; refusing (re-export against a matching schema, or align table numbers)`,
      );
    }
  }
}

/* --- import --- */

/**
 * Apply a dump onto a target store, after the collision guard passes. Writes documents + index rows at
 * their REAL ts via `write(..., "Overwrite")` (INSERT-OR-REPLACE overlay) — preserving `_id`,
 * `_creationTime` (a field IN the value), and prev_ts chains — so a FRESH target reproduces the source
 * state exactly. Idempotent for the same dump. Returns the counts applied.
 *
 * NOTE: this does NOT advance the runtime's timestamp oracle — the caller (e.g. `AdminApi.importDump`)
 * must call `runtime.observeTimestamp(await store.maxTimestamp())` afterward, or a freshly-booted
 * runtime keeps reading at `ts <= 0` and sees nothing. Import targets a FRESH deployment; importing
 * onto a store with divergent data merges by MVCC-latest-ts and is not a supported merge.
 */
export async function applyDumpToStore(
  store: ImportableDocStore,
  dump: MigrationDump,
  targetTableNumbers: Record<string, number>,
): Promise<{ documents: number; indexUpdates: number }> {
  assertImportableTableNumbers(dump, targetTableNumbers);
  const { documents, indexUpdates } = decodeDumpRows(dump);
  await store.write(documents, indexUpdates, "Overwrite");
  return { documents: documents.length, indexUpdates: indexUpdates.length };
}
