# @helipod/objectstore-s3

The S3-compatible implementation of the Helipod `ObjectStore` seam.

This adapter implements the object-storage contract defined by
`@helipod/objectstore` against any S3-compatible service — AWS S3, MinIO,
Cloudflare R2, and similar. Immutable segment writes use create-only
conditional PUTs so a stale writer can never clobber a live object, and the
compare-and-swap put maps to server-side `If-Match`/`If-None-Match`
preconditions, making its CAS safe across processes — the property Helipod's
multi-node object-storage tier depends on for its commit fence.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
