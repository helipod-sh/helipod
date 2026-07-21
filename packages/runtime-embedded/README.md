# @helipod/runtime-embedded

Composes storage, transactor, executor, and sync into one embeddable Helipod runtime.

This package is the single-process engine core: it wires the document store, the
transactor, the function executor, and the reactive sync tier together, boots any
composed components and their background drivers, and drives the write fan-out that
wakes subscriptions after each commit. It exposes in-memory loopback connections so a
client can talk to the engine without a network hop, alongside the WebSocket path.

`helipod dev`, `helipod serve`, and the single-binary build produced by
`helipod build` all boot their engine through this package, so every entrypoint runs
the same runtime with the same behavior.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
