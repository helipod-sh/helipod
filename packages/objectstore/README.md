# @helipod/objectstore

The `ObjectStore` interface: Helipod's object-storage seam for durable engine state.

This package defines the small contract Helipod's storage/compute-separation
tier uses to keep durable state in an object store: immutable keep-first puts
for log segments, a conditional compare-and-swap put (the commit linearization
point, used for the manifest fence), etag-carrying reads, prefix listing, and
delete. Concrete implementations live in `@helipod/objectstore-fs` and
`@helipod/objectstore-s3`; the engine depends only on this interface. The
shared conformance suite and an in-memory reference store for tests also live
here.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
