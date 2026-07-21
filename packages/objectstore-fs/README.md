# @helipod/objectstore-fs

The filesystem implementation of the Helipod `ObjectStore` seam.

This adapter implements the object-storage contract defined by
`@helipod/objectstore` on a local directory: immutable segment writes,
content-hash etags, prefix listing, and a compare-and-swap put guarded by an
in-process mutex. Because its CAS is process-local, it is intended for
development, testing, and single-process deployments; multi-writer deployments
need a store with server-side conditional writes, such as
`@helipod/objectstore-s3`.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
