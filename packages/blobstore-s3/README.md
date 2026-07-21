# @helipod/blobstore-s3

The S3-compatible implementation of the Helipod `BlobStore` file-storage seam.

This adapter stores file bytes in any S3-compatible bucket — AWS S3, MinIO,
Cloudflare R2, and similar services. Uploads are presigned: clients PUT bytes
directly to the bucket, bypassing the Helipod server entirely, then confirm the
upload with the engine; downloads of private files redirect to short-lived
signed bucket URLs. It is selected by setting `HELIPOD_STORAGE_BUCKET` (or the
`--storage-bucket` flag) on the server; when unset, Helipod falls back to the
filesystem adapter.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
