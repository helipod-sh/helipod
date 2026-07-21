# @helipod/docstore-sqlite

The SQLite implementation of the Helipod `DocStore` — the zero-config default storage backend.

This adapter implements the MVCC document-log storage seam defined by
`@helipod/docstore` on top of SQLite. It is the backend Helipod uses out of the
box for local development and single-node deployments: no configuration, one
database file under the data directory. Under Bun it uses `bun:sqlite`; under
Node it uses the built-in `node:sqlite` driver, both behind a small
`DatabaseAdapter` interface so the store itself stays driver-agnostic.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
