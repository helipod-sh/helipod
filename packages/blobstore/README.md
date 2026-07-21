# @helipod/blobstore

The `BlobStore` interface: the byte-storage seam behind Helipod's file storage.

This package defines the contract Helipod's file-storage engine
(`@helipod/storage`) uses to read and write actual file bytes — upload targets
(proxied or presigned), streamed store/read with byte-range support, signed
URLs, and metadata lookup. File metadata itself lives in the database; only the
bytes go through this seam. Concrete implementations live in sibling packages
such as `@helipod/blobstore-fs`, `@helipod/blobstore-s3`, and
`@helipod/blobstore-r2`, and the engine never imports a storage driver
directly. The shared adapter conformance suite also lives here.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
