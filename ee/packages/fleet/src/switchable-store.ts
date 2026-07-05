/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
import type {
  CommitGuardUnit,
  ClientVerdictRecord,
  ClientVerdictWrite,
  CommitUnit,
  ConflictStrategy,
  DocStore,
  DocumentLogEntry,
  IndexWrite,
  Interval,
  LatestDocument,
  Order,
  PrevRevQuery,
  SchemaSetupOptions,
  ShardId,
  TimestampRange,
  InternalDocumentId,
} from "@helipod/docstore";
import type { JSONValue } from "@helipod/values";

/**
 * A `DocStore` that forwards every call to a swappable inner delegate, so a replica-to-primary
 * promotion (Task 4) can become a single atomic pointer swap instead of a coordinated teardown of
 * every in-flight caller.
 *
 * Atomicity contract: each method reads `this.delegate` exactly once, at call entry, into a local
 * binding, and completes its whole operation against that snapshot. A call already in progress when
 * `swapTo()` runs finishes against the OLD delegate; a call started after `swapTo()` returns sees
 * the NEW one. There is no instant where a single call is torn between two delegates. This holds for
 * the async generators too (`index_scan`/`load_documents`): the delegate is captured before the
 * first `yield`, so a scan already draining rows from the old store keeps draining the old store to
 * completion even if `swapTo()` runs concurrently.
 *
 * `close()` semantics: closes only the CURRENT delegate (whatever `this.delegate` is at the moment
 * `close()` is called). It does NOT close a delegate that was swapped out by an earlier `swapTo()` —
 * this class has no memory of former delegates once replaced. Closing a swapped-out (e.g. demoted
 * primary, or promoted-from replica) delegate is the lifecycle owner's responsibility (Task 4
 * decides when that's safe — e.g. after draining its in-flight callers), not this wrapper's.
 */
export class SwitchableDocStore implements DocStore {
  private delegate: DocStore;

  constructor(initial: DocStore) {
    this.delegate = initial;
  }

  /** Atomically repoint all future calls at `next`. Does not touch the outgoing delegate. */
  swapTo(next: DocStore): void {
    this.delegate = next;
  }

  /** The delegate current calls are being forwarded to. */
  current(): DocStore {
    return this.delegate;
  }

  async setupSchema(options?: SchemaSetupOptions): Promise<void> {
    const d = this.delegate;
    return d.setupSchema(options);
  }

  async write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void> {
    const d = this.delegate;
    return d.write(documents, indexUpdates, conflictStrategy, shardId);
  }

  async commitWrite(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    shardId?: ShardId,
    // Additive 4th param (Fleet B3, D3 — opaque commit metadata): forwarded through mechanically,
    // same as every other argument this pass-through wrapper already relays untouched.
    opts?: { meta?: Record<string, string> },
  ): Promise<bigint> {
    const d = this.delegate;
    return d.commitWrite(documents, indexUpdates, shardId, opts);
  }

  async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    const d = this.delegate;
    return d.commitWriteBatch(units, shardId);
  }

  /** Forwards to the CURRENT delegate at call entry, same atomicity contract as every other
   * method here — but note the resulting registration is NOT itself re-forwarded on a later
   * `swapTo()`: the guard lands on whichever concrete store was `this.delegate` at the moment
   * `addCommitGuard` was called, and stays registered there even after the switchable repoints
   * elsewhere. In practice fleet code (`node.ts`) always calls `addCommitGuard` on the concrete
   * `PostgresDocStore` directly (never through this wrapper), so this pass-through exists purely
   * for `DocStore` interface conformance. */
  addCommitGuard(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors DocStore.addCommitGuard
    guard: (q: any, units: readonly CommitGuardUnit[], shardId: ShardId) => void | Promise<void>,
  ): () => void {
    const d = this.delegate;
    return d.addCommitGuard(guard);
  }

  async get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null> {
    const d = this.delegate;
    return d.get(id, readTimestamp);
  }

  async *index_scan(
    indexId: string,
    tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]> {
    const d = this.delegate; // captured before the first yield — see class docstring
    yield* d.index_scan(indexId, tableId, readTimestamp, interval, order, limit);
  }

  async *load_documents(
    range: TimestampRange,
    order: Order,
    limit?: number,
  ): AsyncGenerator<DocumentLogEntry> {
    const d = this.delegate; // captured before the first yield — see class docstring
    yield* d.load_documents(range, order, limit);
  }

  async previous_revisions(
    queries: readonly PrevRevQuery[],
  ): Promise<Map<string, DocumentLogEntry>> {
    const d = this.delegate;
    return d.previous_revisions(queries);
  }

  async scan(tableId: string, readTimestamp?: bigint): Promise<LatestDocument[]> {
    const d = this.delegate;
    return d.scan(tableId, readTimestamp);
  }

  async count(tableId: string): Promise<number> {
    const d = this.delegate;
    return d.count(tableId);
  }

  async maxTimestamp(): Promise<bigint> {
    const d = this.delegate;
    return d.maxTimestamp();
  }

  async getGlobal(key: string): Promise<JSONValue | null> {
    const d = this.delegate;
    return d.getGlobal(key);
  }

  async writeGlobal(key: string, value: JSONValue): Promise<void> {
    const d = this.delegate;
    return d.writeGlobal(key, value);
  }

  async writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean> {
    const d = this.delegate;
    return d.writeGlobalIfAbsent(key, value);
  }

  // ── Client mutation receipts (the Receipted Outbox, verdict §(c)) — pass-through ──────────────

  async getClientVerdict(identity: string, clientId: string, seq: number): Promise<ClientVerdictRecord | null> {
    const d = this.delegate;
    return d.getClientVerdict(identity, clientId, seq);
  }

  async getClientFloor(identity: string, clientId: string): Promise<number | null> {
    const d = this.delegate;
    return d.getClientFloor(identity, clientId);
  }

  async recordClientVerdict(identity: string, clientId: string, seq: number, record: ClientVerdictWrite): Promise<void> {
    const d = this.delegate;
    return d.recordClientVerdict(identity, clientId, seq, record);
  }

  async updateClientVerdictValue(identity: string, clientId: string, seq: number, value: JSONValue): Promise<void> {
    const d = this.delegate;
    return d.updateClientVerdictValue(identity, clientId, seq, value);
  }

  async pruneClientMutations(
    identity: string,
    clientId: string,
    opts: { ackedThrough?: number; ttlBeforeMs?: number },
  ): Promise<{ prunedThroughSeq: number }> {
    const d = this.delegate;
    return d.pruneClientMutations(identity, clientId, opts);
  }

  async sweepExpiredClientMutations(beforeMs: number): Promise<{ deletedCount: number }> {
    const d = this.delegate;
    return d.sweepExpiredClientMutations(beforeMs);
  }

  close(): void | Promise<void> {
    const d = this.delegate;
    return d.close();
  }
}
