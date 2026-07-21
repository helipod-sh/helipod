# @helipod/docstore-d1

The Cloudflare D1 adapter backing Helipod's `.global()` tables.

Unlike the MVCC-log adapters, this store is relational: each global table maps
to a real D1 table with one column per field, real unique indexes, and a JSON
column type for nested values. It is used by Helipod's Cloudflare deployment
path to give `.global()` tables a single strongly-consistent home (with
cross-shard read-your-writes and global unique constraints) alongside the
per-shard document stores. It ships the D1 client seam, DDL generation, and the
document-to-row codec.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
