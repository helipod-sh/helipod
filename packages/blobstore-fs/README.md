# @helipod/blobstore-fs

The filesystem implementation of the Helipod `BlobStore` — the zero-config default for file storage.

This adapter implements the byte-storage seam defined by `@helipod/blobstore`
on the local filesystem, keeping file bytes under the server's data directory
(`<data-dir>/storage`). Uploads are proxied: the client sends bytes to the
Helipod server's own upload endpoint, which stores and finalizes them in one
round trip. It is the backend Helipod uses whenever no object-storage bucket is
configured — nothing to set up for local development or single-node
self-hosting.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
