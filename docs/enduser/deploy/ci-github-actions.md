---
title: GitHub Actions
---

# GitHub Actions

> A copy-paste workflow: validate every PR (`--check --dry-run`), deploy on merge to `main`.

`stackbase deploy` is designed so CI is just another caller of the same seam — the workflow below
runs the *identical* `stackbase deploy` command a human would run locally; only the credentials and
`--check`/`--dry-run` flags differ by event.

## The workflow

```yaml
name: deploy
on:
  pull_request:
  push: { branches: [main] }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: npm i -D wrangler
      # PRs: validate only (drift + dry-run). No secrets needed for --check.
      - if: github.event_name == 'pull_request'
        run: bunx stackbase deploy --check --dry-run --target cloudflare
      # main: real production deploy.
      - if: github.ref == 'refs/heads/main'
        run: bunx stackbase deploy --target cloudflare --env production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          STACKBASE_ADMIN_KEY: ${{ secrets.STACKBASE_ADMIN_KEY }}
```

Adjust the `--target` (and `env:` block) for whichever target you use — see
[Deploy Targets](/deploy/targets) for the full list, or [Cloudflare](/deploy/cloudflare) /
[`stackbase deploy`](/deploying) for what each target's own required credentials are.

## What each step is doing

- **`bun install` / `npm i -D wrangler`** — the workflow installs both Stackbase's own workspace
  deps and the provider CLI the target shells out to. Provider CLIs are never bundled into
  `stackbase deploy` — they run as subprocesses at deploy time, so CI has to install them the same
  way you did locally.
- **PR step — `--check --dry-run --target cloudflare`**: `--check` fails the job (non-zero exit) if
  your committed `convex/_generated/` has drifted from a fresh codegen run. `--dry-run` runs
  `preflight` + `package` (validates wrangler is installed, reconciles `wrangler.jsonc` — writing
  the reconciled file to the runner's checkout, not back to your repo) and skips the actual
  `wrangler deploy`. Neither flag requires `CLOUDFLARE_API_TOKEN` for `--check`; `--dry-run`'s
  `preflight` on the `cloudflare` target does still check for it when the runner isn't a TTY (every
  GitHub Actions runner), so if you want the PR job to validate cloudflare's `preflight` fully,
  give it a token too — a read-scoped one is enough since nothing deploys.
- **`main` step — the real deploy**: only runs on `push` to `main` (the `if:` condition), with the
  three secrets a Cloudflare deploy needs as job-scoped `env:`. `stackbase deploy` reads
  `CLOUDFLARE_API_TOKEN` (wrangler's own auth mechanism — the target's `preflight` doesn't consume
  it directly, wrangler does), and your app's `stackbase.config.ts` presumably resolves
  `STACKBASE_ADMIN_KEY` via `env("STACKBASE_ADMIN_KEY")` into the deployed Worker's secret (set once
  with `wrangler secret put`, separately — see [Cloudflare](/deploy/cloudflare#secrets)).

## The rules this workflow follows

- **Tokens come from CI secrets, never `wrangler login`.** `wrangler login` opens a browser for
  interactive OAuth — it has no place in a headless runner. Every provider's CLI in this ecosystem
  reads a token from the environment instead (`CLOUDFLARE_API_TOKEN` for wrangler, analogous env
  vars for `railway`/`flyctl` when those targets ship). GitHub encrypted secrets, injected as job
  `env:`, are the standard way to supply that.
- **Branch → environment mapping lives in the workflow, not the CLI.** `stackbase deploy` only
  knows `--target`/`--env`; it's this YAML's `if:` conditions that decide *when* each target/env
  combination runs. Copy this pattern for a `staging` environment on a different branch, or a
  matrix over multiple targets — it's ordinary GitHub Actions, nothing Stackbase-specific.
- **The CLI is non-interactive by construction, never hangs.** Every target's `preflight` derives
  `interactive` from `stdin.isTTY && !process.env.CI` — GitHub Actions sets `CI=true` on every
  runner, so this is always `false` there. A target with a missing required credential in
  non-interactive mode **fails fast with an actionable error and exits non-zero**; it never prompts
  or blocks waiting on stdin. If this workflow's `main` step is missing a secret, you'll see a clear
  failure message in the job log, not a stuck job.
- **A rejected deploy doesn't leave the workflow unclear about what happened.** Every `stackbase
  deploy` invocation returns a real exit code (0 on success, 1 on failure/rejection) — a failed
  `--check`, a destructive schema change on the `serve` target, or a `wrangler deploy` error all
  fail the job the same way any other non-zero-exit CI step would.

## Related

- [Deploy Targets](/deploy/targets) — `--target`/`--env`, the `deploy` config block, `--dry-run`/`--check` in full.
- [Cloudflare](/deploy/cloudflare) — the `cloudflare` target this example workflow deploys.
- [`stackbase deploy`](/deploying) — the `serve` target, for pushing to an already-running deployment instead.
