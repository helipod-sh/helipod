# @helipod/deploy

The deploy-target seam behind `helipod deploy --target`.

This package defines the common deploy contract and ships the built-in targets:
`serve` (live push to a running Helipod server), `cloudflare`, `docker`, `railway`,
`fly`, and `aws`. Each target knows how to package a project's functions and get them
onto its platform; the CLI resolves the requested target through this package's
registry and drives it with a shared spawner, so provider-specific logic stays out of
the engine and the CLI alike.

It also contains supporting machinery such as module hashing for delta pushes and
configuration reconciliation for targets that manage platform config files.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
