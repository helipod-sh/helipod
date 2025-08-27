---
title: Business Model & Licensing
status: locked-decision
decided: 2025-08-12
---

# Business Model & Licensing

> **Locked decision.** Do not relitigate without the user. This is the money + license
> strategy for Stackbase. It is deliberately separate from the *architecture* locked
> decisions in `CLAUDE.md` (language, storage seam, deploy baseline) — those say *how it's
> built*; this says *how it stays free, stays protected, and eventually earns*.

## TL;DR — the decision

**Free now, gate scale later — with the protective license set from day one.**

1. **Everything is free now** — including scale/distributed features when they're built. The
   goal of Phase 1 is **popularity and adoption**, nothing else. No paywall, no license key, no
   paid tier yet.
2. **The license is protective from the first commit** — [**FSL-1.1-Apache-2.0**](https://fsl.software)
   (the Functional Source License, same one Convex uses). Free to use, free to self-host, free
   to modify — but you **may not offer Stackbase as a competing hosted service**. Each release
   auto-converts to Apache 2.0 after 2 years.
3. **Later — after popularity — we add a license-key gate on *scaling up*.** Running Stackbase
   at scale (the distributed multi-node Tier 2 fleet + enterprise features) will require a paid
   license from us. **You still deploy anywhere you want, on your own infrastructure** — a
   yearly (or one-time) license *unlocks the scale capability*; it does not restrict where or
   how you deploy. Bring your own cloud.
4. **No managed cloud from us, at least near-term.** We are not running a hosting business. We
   ship software and sell license keys (the **n8n / GitLab-EE model**), not compute.

The one thing that makes this whole plan work: **we set the right *license* now and add the
*paywall code* later** — never the reverse. See "Why the sequencing is the whole game" below.

## Why this model

Constraints that drove it:

- **Small, self-funded team, no appetite to run a cloud** (no ops, no on-call, no infra
  bills). Rules out the Convex/Supabase "we host it" primary-revenue model — at least for now.
- **Popularity first.** Stackbase is unknown; adoption is the only thing that matters early.
  Anything that adds friction or cost now is wrong.
- **Identity is "deploy anywhere, no lock-in — the anti-Firebase."** Any model that forces
  users onto our infrastructure to scale would undercut the core pitch. So we sell a
  *capability unlock*, not *deployment*.
- **Must survive being strip-mined.** The engine *is* the product (unlike Supabase, whose moat
  is Postgres). A permissive license would let a cloud provider host us and give nothing back
  (what happened to MongoDB / Elastic / Redis / HashiCorp). The license must forbid that.

## The free-forever promise (what is NEVER gated)

To keep the "no lock-in" identity honest, these stay free under FSL, permanently:

- **Single-node self-host** — the full engine (functions, reactivity, workflows + saga,
  storage, scheduler, actions, httpAction, Postgres adapter, single-binary build, dashboard).
  Production-usable for the large majority of real apps.
- **Deploy anywhere** — your box, your VPS, your cloud, Docker, an air-gapped server. No
  phone-home, ever.
- **Data + code portability** — plain HTTP, open formats, `stackbase migrate` in *and* your
  data out. You are never trapped.

Paying, when the gate exists, buys **scale + enterprise capability** — not the right to
deploy, and not your own data.

## The two phases

| | **Phase 1 — Grow (now)** | **Phase 2 — Earn (after popularity)** |
|---|---|---|
| Price | Everything free | Single-node stays free; **scale/enterprise require a paid license** |
| License | FSL-1.1-Apache-2.0, whole repo | FSL core **+** a separate commercial license on the `ee/` scale/enterprise modules |
| Gate | None | A signed **license key**, verified offline at boot |
| Our infra | None | None (still no mandatory cloud) |
| Deploy | Anywhere | **Still anywhere** — the key unlocks scale, not deployment |

**Trigger for Phase 2:** meaningful adoption + real demand for multi-node scale. Not a date —
a signal. Until then, everything ships free.

## Why the sequencing is the whole game

The tempting-but-fatal move is "start fully permissive (MIT/Apache) for max popularity, then
relicense to lock scale later." **Never do this.** Every project that relicensed
permissive → restrictive got hostile-forked and lost its community:

- Redis → forked to **Valkey** (Linux Foundation)
- Elastic → forked to **OpenSearch** (AWS)
- Terraform → forked to **OpenTofu**
- (HashiCorp's BUSL move drove the same reaction)

The backlash is never about *adding a paid feature* — n8n and GitLab add paid features
constantly and nobody blinks. It's about **changing the license on code people already have**.
The fix:

- **"Free" ≠ "MIT."** FSL is free to use and self-host but *not* permissive — so we get all the
  popularity of free with none of the strip-mine exposure and none of the relicense trap.
- **Set the license once, now, correctly.** Then Phase 2 is just *shipping code* (a new module
  + a key check) under terms that were already in place — a normal release, not a rug-pull.

## Licensing specifics

- **Free core → FSL-1.1-Apache-2.0.** Forbids only the one thing we care about (offering
  Stackbase as a competing service); converts to Apache 2.0 after 2 years (a strong trust
  signal — users are never permanently locked to our terms). Developer-accepted precedent:
  it's literally the license Convex uses.
- **Future paid scale/enterprise → a *separate* commercial license, in a reserved `ee/`
  (or `packages/enterprise/*`) area.** NOT under FSL — because FSL's 2-year Apache conversion
  would otherwise turn the paid tier free. The GitLab `ee/`-folder / n8n enterprise-split
  pattern. Reserve this convention *now*; the code lands there when Tier 2 is built.
- **Not SSPL** (MongoDB) — viral-copyleft, scares users, got MongoDB removed from Linux
  distros. Too toxic for an adoption-first project.
- **Not MIT/Apache as the base** — see the sequencing section: it's the relicense trap.

## Safeguards to decide/do NOW so Phase 2 stays clean

1. **Adopt FSL from the first public commit** — before publishing packages or accepting the
   first outside contribution.
2. **Require a CLA or DCO from contributors from day one.** This keeps *our* future
   licensing/dual-licensing rights open even after the community contributes. Impossible to add
   retroactively; the thing HashiCorp had and Redis wished it had.
3. **Reserve the `ee/` + separate-commercial-license convention** for future paid code, so the
   FSL Apache-conversion can never leak the paid tier.
4. **Build the entitlement seam *with* Tier 2, not after.** The scale features need one clean
   `if (license.has("scale"))` boundary from the start. Retrofitting it onto already-shipped
   open code is the expensive path (the Elastic mistake).

## Gate mechanics (Phase 2, for reference)

- **License key = a signed token** (e.g. a JWT signed with our private key) carrying
  entitlements + expiry: `{ scale: true, sso: true, exp: "..." }`. The binary ships our *public*
  key and verifies the signature **offline at boot**. No phone-home — respects self-host and
  air-gapped deployments.
- **Enforcement is legal + social, not DRM.** Because the source is visible, a determined
  person could patch out the check. That's fine and is exactly how n8n/GitLab/Sentry operate —
  businesses don't risk a license violation to save a minimal fee, and hobbyists who might
  patch it don't need multi-node scale anyway. Do not over-engineer unbreakable DRM.
- **Introduce the gate cleanly:** gate *new* scale capability and/or grandfather existing
  users; never silently disable something someone already ran. The protective license + CLA are
  what make this a product step rather than a betrayal.

## Pricing shape (Phase 2, indicative)

- **Flat and transparent** — a yearly subscription per deployment/cluster (funds ongoing
  development and updates) **or** a perpetual one-time per major version. Keep it "minimal," as
  intended — a clear number, not a negotiation.
- **No usage metering** — metering needs a phone-home/control-plane we deliberately don't have.
- **Bundle scale with enterprise** — sell "Scale/Enterprise" (multi-node + SSO/SAML + RBAC +
  audit + priority support) as one key, not raw sharding alone. Stronger value, easier price.

## Honest caveats

- **No recurring usage revenue.** A cloud earns continuously as customers grow; a license earns
  once (or yearly) at the unlock moment. Lower ceiling — but near-zero operating cost and no
  ops burden, which is the correct trade for a team that doesn't want to run infrastructure.
- **Revenue depends on people hitting the ceiling *and* choosing to pay** (vs staying
  single-node or sharding manually). Mitigated by making the paid tier genuinely painful to
  rebuild — which distributed scale-out is.
- **You can add a managed cloud later.** The key model doesn't foreclose it; n8n started
  keys-first and layered Cloud on afterward. Keep the option, don't build it now.

## Precedents

- **Do this:** n8n (fair-code + self-hostable enterprise key, added Cloud later), GitLab
  (`ee/` open-core), Convex (FSL, our closest architectural analog), Sentry (FSL/BUSL author).
- **Avoid this:** Redis, Elastic, HashiCorp, Terraform — all relicensed permissive →
  restrictive *after* the fact and were hostile-forked. The anti-pattern this whole plan exists
  to sidestep.

## Status

- **Model: decided (2025-08-12).** Free-now / gate-scale-later, n8n-style key unlock, no
  mandatory managed cloud, deploy-anywhere preserved.
- **License: FSL-1.1-Apache-2.0** to be applied before first publish. Paid `ee/` area under a
  separate commercial license, reserved now, populated when Tier 2 ships.
- **Gate: deferred** until after adoption. Build the entitlement seam alongside Tier 2.
