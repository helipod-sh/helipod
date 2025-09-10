/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import type {
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
} from "@stackbase/docstore";
import type { JSONValue } from "@stackbase/values";

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

  async *load_documents(range: TimestampRange, order: Order): AsyncGenerator<DocumentLogEntry> {
    const d = this.delegate; // captured before the first yield — see class docstring
    yield* d.load_documents(range, order);
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

  close(): void | Promise<void> {
    const d = this.delegate;
    return d.close();
  }
}
