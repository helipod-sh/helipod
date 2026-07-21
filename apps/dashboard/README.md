# @helipod/dashboard

The Helipod dashboard: a single-page web app for inspecting and operating a Helipod deployment, served automatically by `helipod dev` and `helipod serve`.

This package is not for direct installation. It exists so the CLI can embed the built SPA (`@helipod/cli` depends on it and serves the `dist/` output); end users get it by running the CLI — there is nothing to add to an app's dependencies.

## Usage

```sh
bunx helipod dev
# open the printed URL and visit /_dashboard
```

In development the dashboard is served with the local admin key baked in. In production (`helipod serve`) it is served key-less — the admin key is never embedded in the HTML — and the SPA prompts for `HELIPOD_ADMIN_KEY` on first load.

## Features

- Live data browser: tables and documents update in real time over an admin sync subscription, with cursor pagination and structured filters.
- Logs viewer: function execution logs for queries, mutations, and actions.
- Function runner: call any query, mutation, or action with JSON arguments and inspect the result.
- Document editing through the admin HTTP API, with edits reflected immediately in the live view.

## Development

Within the monorepo:

```sh
bun run --filter @helipod/dashboard dev     # Vite dev server
bun run --filter @helipod/dashboard build   # build dist/ consumed by the CLI
```

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
