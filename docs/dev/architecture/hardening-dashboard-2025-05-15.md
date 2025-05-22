---
title: Hardening pass — dashboard slice (2025-05-15)
status: applied
---

# Hardening — adversarial review of the dashboard slice

A 4-reviewer adversarial workflow (each finding verified by an independent skeptic) over the
dashboard slice — admin API (`packages/admin`), dev-server serving (`packages/cli`), and the SPA
(`apps/dashboard`) — surfaced **13 candidates → 12 confirmed** (several were duplicate reports of two
underlying issues). Disposition below.

## Fixed (9 distinct issues)

| Severity | Finding | Fix |
|---|---|---|
| **high** | `adminSend` never checked `response.ok` → a failed DELETE/PATCH/POST silently looked successful (the delete path ignored the result) | `adminSend` throws on non-OK (like `adminGet`); `del()` wraps in try/catch and surfaces an error banner. |
| **high** | A persistent `STACKBASE_ADMIN_KEY` was embedded in the **unauthenticated** `/_dashboard` HTML — readable by any client on a non-loopback bind | Inject the key only for an **ephemeral key on a loopback bind**; otherwise serve plain HTML and the SPA prompts for the key (sessionStorage). Verified both cases live. |
| medium | A document field literally named `__proto__` was silently dropped by `jsonToConvex`/`convexToJson` (the `out[key]=…` prototype-setter trap) — in the **core** value codec, on the hot path for all queries/mutations | `setObjectKey` uses `Object.defineProperty` for `__proto__`. Round-trip regression test added. |
| medium | The **Bun** backend (primary runtime) read request bodies with **no size cap** (only Node enforced `MAX_BODY_BYTES`) | Pass `maxRequestBodySize: MAX_BODY_BYTES` to `Bun.serve`. |
| medium | Edit (`_system:patchDocument`) **merged** instead of replaced, so the whole-document JSON editor could never remove a field | Whole-document replace (`_id`/`_creationTime` preserved by the kernel). Regression test added. |
| low | The data-browser equality filter compared raw Convex values (bigint/bytes) instead of the displayed JSON | Convert to `convexToJson` up front; filter + paginate on that representation. |
| low | Empty `STACKBASE_ADMIN_KEY` produced an always-401 dashboard with no warning | Treat empty/whitespace as unset; warn and fall back to an ephemeral key. |
| low | The injected key wasn't `</script>`-escaped (an env key could break out of the inline script) | Escape `<` → `<` in the injected JSON. |

## Deferred (with rationale)

- **getTableData full-table scan** (reported 3×: ADM-2/X3/spa-3) — scans the whole table into memory
  per request. A real perf item, but the proper fix pushes pagination into the `DocStore` seam
  (SQL `LIMIT`/cursor); the spec pre-accepted v1 full-scan for Tier-0 dev dashboards. Noted in code;
  filter/total now operate on the JSON docs as a partial improvement.

## Rejected as a false positive (1)

- **SPA deep-link 404** — the SPA uses **hash routing** (`createHashHistory`), so deep links are
  `/_dashboard#/...`; the path is always `/_dashboard` and never needs a server-side history
  fallback.

Workspace after fixes: build 17/17, typecheck 33/33, test 33/33.
