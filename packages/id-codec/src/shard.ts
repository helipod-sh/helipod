/**
 * Sharding primitives — scale-seam #1. A conversation (or any partition) maps to a shard
 * key derived from a document field; a shard router maps that key to the single-writer
 * shard that owns it. At **Tier 0 there is exactly one shard (`"default"`)** and the
 * router always returns it, but the seam exists in the interfaces from day one so Tier 2
 * per-conversation sharding is a config swap, not an engine rewrite.
 */
export type ShardId = string;
export type ShardKey = string;

export const DEFAULT_SHARD: ShardId = "default";

export interface ShardKeyResolverInput {
  table: string;
  document: Record<string, unknown>;
}

/** Extracts the shard key from a document, or null if the table isn't sharded. */
export interface ShardKeyResolver {
  resolve(input: ShardKeyResolverInput): ShardKey | null;
}

/** Tier 0: nothing is sharded — every document lives in the default shard. */
export class DefaultShardKeyResolver implements ShardKeyResolver {
  resolve(): ShardKey | null {
    return null;
  }
}

/** Resolves the shard key from a configured field per table (e.g. `messages.conversationId`). */
export class FieldShardKeyResolver implements ShardKeyResolver {
  constructor(private readonly fieldByTable: ReadonlyMap<string, string>) {}

  resolve({ table, document }: ShardKeyResolverInput): ShardKey | null {
    const field = this.fieldByTable.get(table);
    if (field === undefined) return null;
    const value = document[field];
    return value === undefined || value === null ? null : String(value);
  }
}

/**
 * Routes shard keys and clients to shards/nodes. Tier 2 implements consistent hashing
 * (document→committer) and rendezvous hashing (client→sync node); `TStub` is the
 * per-shard handle (e.g. a Durable Object stub).
 */
export interface ShardRouter<TStub = unknown> {
  getShardForKey(shardKey: ShardKey | null): ShardId;
  getShardForDocument(table: string, shardKey: ShardKey | null): ShardId;
  getSyncNodeId(clientId: string): string;
  resolveStub?(shardId: ShardId): TStub;
}

/** Tier 0 router: one shard, one local sync node. */
export class SimpleShardRouter implements ShardRouter {
  getShardForKey(_shardKey: ShardKey | null): ShardId {
    return DEFAULT_SHARD;
  }
  getShardForDocument(_table: string, _shardKey: ShardKey | null): ShardId {
    return DEFAULT_SHARD;
  }
  getSyncNodeId(_clientId: string): string {
    return "local";
  }
}
