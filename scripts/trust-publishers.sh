#!/usr/bin/env bash
#
# Bulk-configure npm trusted publishing (OIDC) for every helipod package.
#
# WHY: each package needs a "trusted publisher" on npm pointing at our release
# workflow, so CI can publish WITHOUT a long-lived token. Doing that by hand in
# the npmjs.com UI is ~44 web forms. `npm trust` does it from the terminal; this
# loops it over the exact set scripts/release.mjs publishes (via the shared
# scripts/list-publishable.mjs), so the trust set can never drift from the
# publish set.
#
# PREREQS (all on YOUR machine, not CI):
#   1. Real npm >= 11.15  ->  `npm install -g npm@latest`
#      (Note: in this repo `npm` is shimmed to bun, so we call the real binary
#       explicitly as `command npm`. Check with: command npm --version)
#   2. Logged in:  `command npm login`  (a granular token is fine)
#   3. Run from the repo root.
#
# THE 2FA TRICK: your first `npm trust` triggers 2FA. npmjs.com then offers a
# "skip 2FA for the next 5 minutes" toggle — enable it and this whole loop runs
# unattended. 44 packages x ~2s ~= 90s, comfortably inside the window.
#
# USAGE:
#   scripts/trust-publishers.sh            # DRY RUN — prints the commands, changes nothing
#   scripts/trust-publishers.sh --apply    # actually configure trusted publishers
#
# The dry run exists so you can verify the exact `npm trust` flags against your
# npm's `command npm trust --help` before firing 44 real mutations.
set -euo pipefail

REPO="helipod-sh/helipod"
WORKFLOW="release.yml"   # filename under .github/workflows/, as npm expects
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

cd "$(dirname "$0")/.."

# --- enumerate the published set (single source of truth) --------------------
# (read loop rather than mapfile — macOS ships bash 3.2, which lacks mapfile)
PKGS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && PKGS+=("$line")
done < <(node scripts/list-publishable.mjs)
if [[ ${#PKGS[@]} -eq 0 ]]; then
  echo "no publishable packages found — are you in the repo root?" >&2
  exit 1
fi
echo "found ${#PKGS[@]} publishable packages"

# --- the command we run per package ------------------------------------------
# `npm trust github <pkg> --repo <owner/repo> --file <workflow> --allow-publish --yes`
# ships in npm >= 11.15. If your npm names a flag differently, adjust here after
# checking `command npm trust --help` — the dry run prints exactly what will run.
trust_cmd() {
  local pkg="$1"
  printf 'command npm trust github %q --repo %q --file %q --allow-publish --yes' \
    "$pkg" "$REPO" "$WORKFLOW"
}

if [[ $APPLY -eq 0 ]]; then
  echo
  echo "DRY RUN — these commands would run (pass --apply to execute):"
  echo
  for pkg in "${PKGS[@]}"; do
    echo "  $(trust_cmd "$pkg")"
  done
  echo
  echo "Review against 'command npm trust --help', then re-run with --apply."
  exit 0
fi

# --- preflight (only when actually applying) ---------------------------------
NPM_VER="$(command npm --version 2>/dev/null || echo 0.0.0)"
# require >= 11.15.0
if [[ "$(printf '%s\n11.15.0\n' "$NPM_VER" | sort -V | head -1)" != "11.15.0" ]]; then
  echo "npm $NPM_VER is too old for 'npm trust' — need >= 11.15.0." >&2
  echo "Run:  npm install -g npm@latest" >&2
  exit 1
fi
if ! command npm whoami >/dev/null 2>&1; then
  echo "not logged in to npm — run 'command npm login' first." >&2
  exit 1
fi
echo "npm $NPM_VER, logged in as $(command npm whoami). configuring ${#PKGS[@]} packages…"
echo

# --- apply, skipping (not stranding) any that fail ---------------------------
ok=0; failed=()
for pkg in "${PKGS[@]}"; do
  printf '  %-34s ' "$pkg"
  if eval "$(trust_cmd "$pkg")" >/dev/null 2>&1; then
    echo "trusted"
    ok=$((ok + 1))
  else
    echo "FAILED"
    failed+=("$pkg")
  fi
  sleep 2   # stay under npm's write rate limit
done

echo
echo "done: $ok trusted, ${#failed[@]} failed"
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "failed: ${failed[*]}" >&2
  echo "(a brand-new package can't be trusted until it exists on the registry —" >&2
  echo " publish it once first; see docs/dev/publishing.md)" >&2
  exit 1
fi
