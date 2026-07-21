# @helipod/blobstore-r2

The Cloudflare R2 implementation of the Helipod `BlobStore` file-storage seam.

This adapter stores file bytes in a Cloudflare R2 bucket through the native R2
binding available to Workers and Durable Objects, rather than over the
S3-compatible HTTP API. It exists for Helipod's Cloudflare deployment path,
where the engine runs inside a Durable Object and talks to R2 in-platform. For
deployments outside Cloudflare (or when reaching R2 over its S3 endpoint), use
`@helipod/blobstore-s3` instead.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
