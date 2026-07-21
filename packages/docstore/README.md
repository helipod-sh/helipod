# @helipod/docstore

The `DocStore` interface: the storage seam every Helipod database adapter implements.

This package defines the contract between the Helipod engine and its persistence
layer — an append-only MVCC document log with index writes, commit units, commit
guards, and a monotonic timestamp oracle. The engine only ever talks to this
interface; concrete implementations live in sibling packages such as
`@helipod/docstore-sqlite` and `@helipod/docstore-postgres`, so engine logic
never depends on a specific database driver. It also ships the shared
conformance suite that every adapter is tested against.

> This is an internal package of the Helipod engine. Most applications should install [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
