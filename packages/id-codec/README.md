# @helipod/id-codec

Document id encoding and decoding for the Helipod engine.

A Helipod document id packs a table number and a random internal id into a compact,
self-validating string: base32-encoded with a checksum, so a corrupted or foreign id
is rejected at decode time rather than silently misrouted. This package owns that
codec and the binary primitives beneath it (base32, checksums, varints), plus the
table registry that maps table names to numbers, storage id helpers, and the shard
identity types used to route writes.

Everything in the engine that mints, parses, or compares a document id goes through
this package, which is what lets ids stay stable across storage backends and appear
as plain typed strings in application code.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
