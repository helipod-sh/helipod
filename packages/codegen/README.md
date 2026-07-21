# @helipod/codegen

Generates a project's typed `_generated/` files from its schema and functions.

Given a schema and an analyzed manifest of the project's query, mutation, and action
functions, this package emits the generated modules an application imports: the typed
`api` and internal API references, the data model (`Doc` and `Id` types per table),
the server helpers, and the id-minting map. This is what makes calls like
`useQuery(api.messages.list)` fully type-safe end to end, from a function's argument
validators through to the client.

It is invoked by the `helipod` CLI during `helipod dev` and `helipod codegen`, and also
validates shard-by declarations before emitting. Applications never depend on it
directly; they consume its output as checked-in generated files.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
