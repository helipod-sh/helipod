# @helipod/docstore-postgres

The PostgreSQL implementation of the Helipod `DocStore` storage seam.

This adapter runs the same MVCC document log as the SQLite backend on top of
Postgres. It is physically schemaless — application tables and fields live as
data inside a small fixed set of internal tables, so evolving your schema never
requires a migration. A Postgres advisory lock enforces the single-writer
invariant (a second engine against the same database fails fast), and paginated
reads use streaming index scans that stop as soon as the caller does. It is
selected by passing `--database-url` to `helipod serve` or setting
`HELIPOD_DATABASE_URL`; both the native Bun SQL client and the `pg` driver are
supported behind a narrow client seam.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
