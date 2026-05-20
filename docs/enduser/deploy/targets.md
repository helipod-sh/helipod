---
title: Deploy Targets
---

# Deploy Targets

> `stackbase deploy --target <name> --env <name>` — one command, multiple providers, named
> environments. The seam behind it is `@stackbase/deploy`.

`stackbase deploy` started as a single thing: push transpiled functions to a running `stackbase
serve` (see [`stackbase deploy`](/deploying) for that flow in full — it still works exactly as
documented there, unchanged, as the `serve` target's back-compat default). This page documents the
general form: a **target/environment model** that lets the same command provision infrastructure on
other providers too, with **adding a new provider** meaning "write one more adapter on the same
seam," not "reimplement the CLI."

## Two modes

Every target is one of two shapes:

- **Push mode** — send transpiled functions + additive schema to an **already-running** Stackbase
  deployment. Live hot-swap, no restart. This is the `serve` target — exactly [slice 6b's
  behavior](/deploying), reframed as one target among several.
- **Provision mode** — package a deployable artifact and push it to infrastructure that **isn't
  running yet**: `cloudflare` reconciles a `wrangler.jsonc` and shells `wrangler deploy`; `docker`
  builds and brings up the shipped Docker image via `docker compose up`.

Nothing here bundles a provider SDK. A provision target shells out to that provider's own CLI
(`wrangler`, `docker`) — install it once (`npm i -D wrangler`, install Docker) and `stackbase
deploy` invokes it as a subprocess at deploy time, off the runtime path.

## CLI surface

```bash
stackbase deploy [--target <name>] [--env <name>] [--dir convex] [--dry-run] [--check]
```

| Flag | Meaning |
|---|---|
| `--target <name>` | Which target to deploy to. Defaults to `deploy.defaultTarget` in `stackbase.config.ts`, or `"serve"` if that's unset — preserving the original `stackbase deploy --url …` behavior with no config at all. |
| `--env <name>` | Which named environment within that target. Defaults to `"production"`. |
| `--dir <convexDir>` | Where your app's functions live. Defaults to `convex`. |
| `--dry-run` | Run `preflight` + `package` (validates everything, refreshes codegen, reconciles provider config) and **skip the actual push**. Exit 0 on success. Useful in CI on a PR — you get the same validation without deploying anything. |
| `--check` | **Verification-only, never deploys.** Fails (exit 1) if running codegen would produce a different `convex/_generated/` than what's committed — i.e. your committed generated types have drifted from your actual schema/functions. Exits 0 (or continues, if also given `--dry-run`) when there's no drift. `--check` alone returns immediately after the drift verdict; it never reaches `package`/`push`. |
| `--url <url>` | Back-compat: still works with no `--target`, resolving to the `serve` target with this URL inline (see [`stackbase deploy`](/deploying)). |

## The `deploy` block in `stackbase.config.ts`

```ts
// stackbase.config.ts
import { defineConfig, env } from "@stackbase/component";

export default defineConfig({
  components: [ /* ... */ ],
  deploy: {
    defaultTarget: "serve",
    targets: {
      serve: {
        provider: "serve",
        environments: {
          production: { url: env("STACKBASE_DEPLOY_URL"), adminKey: env("STACKBASE_ADMIN_KEY") },
        },
      },
      cloudflare: {
        provider: "cloudflare",
        // wrangler.jsonc is the source of truth; stackbase deploy reconciles bindings into it,
        // never regenerates it — your hand-edits survive.
        environments: {
          production: {},                      // → `wrangler deploy` (top-level env)
          staging: { wranglerEnv: "staging" },  // → `wrangler deploy --env staging`
        },
      },
    },
  },
});
```

- **`defaultTarget`** — used when `--target` is omitted. Leave it `"serve"` (or omit the whole
  `deploy` block) to keep the original slice-6b `stackbase deploy --url <url>` flow working with
  zero config.
- **`targets`** — keyed by the name you pass to `--target`. Each entry has a `provider` (which
  adapter runs it: `"serve"` | `"cloudflare"` | `"docker"`), any shared settings, and an
  `environments` map. `--env <name>` selects one of those; its fields are merged **over** the
  target's shared settings.
- **`env(name, fallback?)`** — a deferred, Supabase-style env-var read (from `@stackbase/component`).
  It reads `process.env` (or a gitignored `.env` you load yourself) **at config-load time**, not at
  import time, and never throws — an unset var with no fallback resolves to `""`, so a config that
  references a not-yet-set secret still *loads*; the target's own `preflight` is what fail-fasts on
  a genuinely-missing required credential (with a clear, actionable message), not `env()` itself.

## Built-in targets

### `serve` — push to a running deployment

The default. Requires `url` + `adminKey` (from the environment's settings, `--url`, or the
`STACKBASE_DEPLOY_URL`/`STACKBASE_ADMIN_KEY` env vars — exact back-compat with slice 6b). See
[`stackbase deploy`](/deploying) for the full push flow, the additive-only schema gate, and the
`--allow-deploy` opt-in the target server needs.

### `cloudflare` — provision the Durable-Object-native host

Reconciles your `wrangler.jsonc` bindings and shells `wrangler deploy`, provisioning
`@stackbase/runtime-cloudflare`'s Durable-Object-native host. See [Cloudflare](/deploy/cloudflare)
for prerequisites, the required `wrangler.jsonc` shape, and secrets.

Settings: `wranglerEnv` (maps to wrangler's own `--env`), `r2` (`true` to reconcile in an R2
binding for file storage), `r2BucketName` (defaults to `stackbase-storage`).

### `docker` — the real containerized artifact, locally

Runs `docker compose up -d --build` against the repo's `Dockerfile`/`docker-compose.yml` — the same
image [Docker self-hosting](/self-hosting) documents. This is not a remote deploy: it's a target for
testing the *actual production artifact* (container-only bugs a `stackbase dev` loop can't catch)
as a CI smoke gate, or as a literal local "run it for real" step. `preflight` checks the Docker
daemon is reachable and fails fast with an actionable message if it isn't.

## Adding a provider

A new provider is one more adapter behind the same `DeployTarget` interface — no CLI framework
changes, no changes to `resolveDeploy`'s target/env resolution:

```ts
export interface DeployTarget {
  readonly name: string;
  preflight(ctx: DeployContext): Promise<void>;  // fail fast: missing CLI, missing config, missing creds
  package(ctx: DeployContext): Promise<void>;     // produce the artifact — codegen, reconcile config, build
  push(ctx: DeployContext): Promise<DeployResult>; // push/provision; returns { ok, url?, detail?, error? }
}
```

`DeployContext` gives an adapter everything it needs without importing the CLI: `cwd`, `convexDir`,
the resolved `env`/`target` (with merged `settings`), an `interactive` flag (`stdin.isTTY &&
!process.env.CI` — an adapter's `preflight` must never prompt or block on stdin when this is
`false`), an injectable `spawn: Spawner` (`{ run(cmd, args, opts?) }` — the real one shells a
subprocess; tests inject a fake that records calls and returns canned output, so an adapter is
fully unit-testable with no real provider CLI or network), and `packageApp()`/`codegen()` closures
supplied by the CLI (the shared esbuild-transpile-and-codegen machinery every target reuses).

**v1 ships `serve`, `cloudflare`, and `docker`.** `railway`, `fly`, and `aws` adapters are
documented follow-ons — the same shape (`preflight` checks the provider CLI/token, `package` builds
the image, `push` shells `railway up` / `flyctl deploy` / the provider's own tool), not yet built.
Adapters are lazy-loaded (`loadTarget(provider)` dynamically imports the target module), so an
unused provider's dependencies — e.g. `cloudflare`'s dependency on `@stackbase/runtime-cloudflare` —
never load unless that target is actually selected.

## CI / non-interactive deploy

CI is a first-class caller of the same seam — a workflow runs the identical `stackbase deploy
--target <t> --env <e>`, differing only in auth (CI secrets, never an interactive login) and
`interactive` (`false`, since there's no TTY). Every target's `preflight` requires every credential
up front and fails fast with an actionable error in non-interactive mode — never a hang waiting on
stdin. See [GitHub Actions](/deploy/ci-github-actions) for a full copy-paste workflow.

## Related

- [`stackbase deploy`](/deploying) — the `serve` target's push flow, additive-only schema gate,
  `--allow-deploy`.
- [Cloudflare](/deploy/cloudflare) — the `cloudflare` target in full.
- [GitHub Actions](/deploy/ci-github-actions) — a copy-paste CI workflow.
- [Docker Self-Hosting](/self-hosting) — the image the `docker` target builds/runs.
