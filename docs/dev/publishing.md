# Publishing & adding packages

How helipod's ~44 npm packages get to the registry, and the one-time dance a
**new** package needs. Read this before adding a package to `packages/`,
`components/`, or `ee/packages/`.

## The model: OIDC primary, token fallback

Every package is published by CI (`.github/workflows/release.yml` →
`scripts/release.mjs`) using **npm trusted publishing (OIDC)** — no long-lived
token, provenance attested. Trusted publishing means: npm knows "GitHub Actions
in `helipod-sh/helipod` running `release.yml` is allowed to publish this
package," so CI authenticates by identity, not secret. `release.mjs` publishes
each package via OIDC first and only reaches for a token if OIDC fails (see
below).

`release.mjs` publishes every workspace package whose current version isn't yet
on the registry, in dependency order. It is **re-runnable** (already-published
versions are skipped) and **does not strand** packages after a failure — one
package failing to publish doesn't stop the rest.

The set of published packages comes from **`scripts/list-publishable.mjs`**, the
single source of truth shared with the trust-setup script — so "what we publish"
and "what we've configured OIDC for" can never drift.

## The one-time gap: a brand-new package

npm **cannot** configure a trusted publisher for a package that doesn't exist on
the registry yet (there's no "pending publisher" like PyPI has). So a genuinely
new package can't be OIDC-published on its very first release — chicken and egg.

Two things close this, and they compose:

1. **`NPM_TOKEN` secret → automatic first publish.** The workflow passes this
   secret to `release.mjs` as `HELIPOD_NPM_FALLBACK_TOKEN` (a private var name,
   *not* `NPM_TOKEN` — setting `NPM_TOKEN` would make the changesets action
   switch every package to token auth and defeat OIDC). `release.mjs` tries OIDC
   first for each package and, only if that fails, retries **that one package**
   with the token. So an existing package stays tokenless while a brand-new one
   bootstraps automatically on merge with **no human step**. Set the secret once:

   ```bash
   # generate a granular/automation token at npmjs.com with publish rights
   # (scope: @helipod, read+write), then:
   gh secret set NPM_TOKEN -R helipod-sh/helipod
   ```

   > Gotcha we hit once: the workflow originally exposed the secret as
   > `NPM_CONFIG_TOKEN`, which npm does **not** read for registry auth — so the
   > token was inert and the first new-package publish failed. The auth var npm
   > actually reads is `//registry.npmjs.org/:_authToken`, which `release.mjs`
   > now writes to a temp userconfig on the fallback path.

2. **`scripts/trust-publishers.sh` → convert to tokenless OIDC.** Once a package
   exists on the registry, add its trusted publisher so future releases don't
   need the token:

   ```bash
   npm install -g npm@latest        # need npm >= 11.15 for `npm trust`
   command npm login                # (npm is shimmed to bun in this repo)
   scripts/trust-publishers.sh      # DRY RUN — prints the 44 commands
   scripts/trust-publishers.sh --apply
   ```

   Your first `npm trust` triggers 2FA; npmjs.com then offers "skip 2FA for 5
   minutes" — enable it and the whole loop (~90s) runs unattended.

**Steady state after both:** adding a package is a non-event — it self-publishes
via the token on merge, and you re-run `trust-publishers.sh` at your leisure to
move it onto OIDC. No per-package UI clicking, ever.

## Folder layout is irrelevant to any of this

npm sees package **names and the `@helipod` scope**, never your directory tree.
Moving packages into `core/`, `adapters/`, etc. changes nothing about publish
count or OIDC config. Don't reorganize folders to solve a publishing concern.

## Versioning: lockstep vs independent

Core packages are a **`fixed` (lockstep)** group in `.changeset/config.json` —
bump one, bump all, so `helipod@x` always pairs with `@helipod/*@x` (the
Babel/Jest model). This is why one release publishes many packages; it's a
deliberate coherence choice, not overhead — the publishes are automated and free,
and the umbrella `helipod` package pins exact versions so end users never see the
churn. Move a package to independent versioning only if spurious bumps start
hurting *users*, which they don't while everything hides behind the umbrella.

> **Known discrepancy (decide when convenient):** the `components/` packages
> (`@helipod/auth`, `authz`, `notifications`, `scheduler`, `triggers`,
> `workflow`) are **published** by `release.mjs` but are **not** in the `fixed`
> lockstep group, so they version independently of the core. That may be
> intentional (components are opt-in) — but if you want them lockstepped with the
> core, add them to `.changeset/config.json`'s `fixed` array.
