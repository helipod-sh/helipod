# @helipod/component

The component-definition seam that Helipod's opt-in components plug into.

This package provides `defineConfig` for a project's `helipod.config.ts` and the
component contract itself: how a component declares its tables, functions, context
providers, boot steps, HTTP routes, and recurring drivers, and how `composeComponents`
merges a set of components (such as the scheduler, workflow, auth, or triggers
components) into one composed definition the runtime can boot. Drivers are the
reactive event loops woken by the engine's commit fan-out and a wall-clock timer,
which is how components like the scheduler run background work.

It sits between application configuration and the embedded runtime: the CLI resolves
`helipod.config.ts` through this package, then hands the composed result to the engine.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
