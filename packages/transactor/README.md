# @helipod/transactor

The single-writer, optimistic-concurrency transaction engine at the heart of Helipod's
write path.

This package runs each mutation as a serializable transaction over the append-only
document log: it executes the function against a snapshot, validates its recorded
read set against commits that landed concurrently, and either applies the staged
writes atomically or replays the function on conflict. Every commit emits a delta
that the sync tier fans out to invalidate subscriptions, which is what makes writes
reactive. Group commit batches concurrent transactions through the single writer for
throughput, and a sharded variant partitions the write path across multiple writers
while preserving cross-shard read consistency.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
