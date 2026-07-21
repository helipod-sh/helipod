# @helipod/index-key-codec

Order-preserving index key encoding for range scans over Helipod documents.

This package encodes tuples of indexable values into byte strings whose lexicographic
order matches the logical sort order of the values, which is what lets any storage
backend answer index range queries with a plain byte-range scan. It is also the
canonical home for the key-range machinery built on top of that encoding: key ranges
and range sets, keyspace identifiers, cursors, an interval index for fast range
intersection, and the serialized write-invalidation shapes the sync tier uses to
decide which subscriptions a commit affects.

Every other engine package imports these types from here rather than redeclaring
them, keeping the read side, write side, and sync tier in exact agreement about key
order.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
