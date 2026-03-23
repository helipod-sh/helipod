import { mutation, action, httpAction, type ActionCtx, type RegisteredFunction } from "@stackbase/executor";
import type { AuthConfig } from "./config";
import type { OAuthProvider } from "./oauth";
import { authorizationServerFor, buildAuthorizeUrl, isAllowedRedirect, callbackUri, resolveProvider } from "./oauth";
import { resolveSession } from "./functions";
import { sha256base64url } from "./crypto";
import * as oauth from "oauth4webapi";

/**
 * A3 external-identity module set (spec Parts 1-5). Task 2 wired the conditional-registration
 * plumbing: `makeAuthModules` (functions.ts) calls `makeExternalModules(config)` whenever `oauth`
 * or `jwt` is configured, and the SET of keys registered here is what `external-config.test.ts`
 * pins as the observable contract. Task 3 (this file, `oauthState` + `/start`) replaces the
 * `_startOAuth`/`oauthHttp`(start branch) placeholders with real implementations. Task 4
 * (`_resolveExternalIdentity`'s real resolution/linking matrix), Task 5 (`/callback` + token
 * exchange + `oauthHandoff` + `completeOAuthSignIn`), and Task 6 (`signInWithIdToken` + jose JWKS
 * verify) replace the remaining placeholder bodies below — the registration shape (which keys
 * exist, under which config) does not change.
 */

const NOT_IMPLEMENTED = "not implemented — lands in a later A3 task";
const GENERIC = "authentication failed"; // no enumeration — every OAuth/JWT failure surfaces as this

/** A tiny 302 helper (browser redirect out of the httpAction). */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
/** A generic error page (no enumeration). Kept text/plain — the browser is mid-redirect flow. */
function fail(status: number): Response {
  return new Response(GENERIC, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Drop `undefined` keys — the syscall codec rejects `undefined` (same as functions.ts's `compact`). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

function bearerOf(request: Request): string | null {
  const h = request.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/.exec(h) : null;
  return m ? (m[1] ?? null) : null;
}

// oauth4webapi random/PKCE helpers, isolated so the callback (Task 5) shares them and tests can stub.
const oauthRandom = {
  state: () => oauth.generateRandomState(),
  nonce: () => oauth.generateRandomNonce(),
  verifier: () => oauth.generateRandomCodeVerifier(),
  challenge: (v: string) => oauth.calculatePKCECodeChallenge(v),
};

/**
 * Build the A3 external-identity module set (spec "Component surface"). Registered by
 * `makeAuthModules` ONLY when `config.oauth`/`config.jwt` is present (conditional registration). OAuth
 * modules gate on `config.oauth`; `signInWithIdToken` on `config.jwt`; `_resolveExternalIdentity` is
 * shared by both and registered when either is present.
 */
export function makeExternalModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const modules: Record<string, RegisteredFunction> = {};

  // ── Part 3 shared resolution (Task 4) — registered when EITHER oauth or jwt is present ──
  if (config.oauth || config.jwt) {
    modules._resolveExternalIdentity = mutation(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 4
    });
  }

  if (config.oauth) {
    modules._startOAuth = _startOAuth(config);
    modules._consumeOAuthState = mutation(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 5
    });
    modules._consumeHandoff = mutation(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 5
    });
    modules.completeOAuthSignIn = action(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 5
    });
    modules.oauthHttp = oauthHttp(config);
  }

  if (config.jwt) {
    modules.signInWithIdToken = action(async (): Promise<never> => {
      throw new Error(NOT_IMPLEMENTED); // Task 6
    });
  }

  return modules;
}

// ─────────────────────────── OAuth `/start` (Task 3) ───────────────────────────

/** Write the hashed state row (+ recoverable verifier/nonce) and resolve `linkUserId` from the caller's
 *  live session token (link-while-signed-in). Called by the `/start` httpAction. Returns null. */
function _startOAuth(config: AuthConfig) {
  return mutation(async (ctx, args: {
    provider: string; stateHash: string; codeVerifier: string; nonce?: string; redirectTo: string; callerToken?: string;
  }): Promise<null> => {
    const now = ctx.now();
    let linkUserId: string | undefined;
    if (args.callerToken) {
      const session = await resolveSession(ctx.db, args.callerToken);
      if (session && now <= (session.expiresAt as number)) linkUserId = session.userId as string;
    }
    await ctx.db.insert("oauthState", compact({
      stateHash: args.stateHash,
      provider: args.provider,
      codeVerifier: args.codeVerifier,
      nonce: args.nonce,
      redirectTo: args.redirectTo,
      linkUserId,
      expiresAt: now + config.oauth!.stateTtlMs,
      createdAt: now,
    }));
    return null;
  });
}

/** The single httpAction backing both `/api/auth/oauth/:provider/start` and `.../callback` (this repo's
 *  routes carry no named params — it parses `<provider>/<phase>` from the path suffix, like storage's
 *  serve handler). Task 3 wires the `start` phase; Task 5 fills `callback`. */
function oauthHttp(config: AuthConfig) {
  return httpAction(async (ctx, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const tail = url.pathname.slice("/api/auth/oauth/".length); // "<provider>/<phase>"
    const slash = tail.indexOf("/");
    const provider = slash === -1 ? tail : tail.slice(0, slash);
    const phase = slash === -1 ? "" : tail.slice(slash + 1);
    const p = resolveProvider(config.oauth!.providers, provider);
    if (!p) return fail(404);

    if (phase === "start") return oauthStart(ctx as ActionCtx, config, request, url, provider, p);
    if (phase === "callback") return fail(501); // Task 5
    return fail(404);
  });
}

async function oauthStart(ctx: ActionCtx, config: AuthConfig, request: Request, url: URL, provider: string, p: OAuthProvider): Promise<Response> {
  const redirectTo = url.searchParams.get("redirectTo") ?? "";
  if (!isAllowedRedirect(redirectTo, config.oauth!.redirectAllowlist)) return fail(400); // BEFORE any state write

  const state = oauthRandom.state();
  const codeVerifier = oauthRandom.verifier();
  const codeChallenge = await oauthRandom.challenge(codeVerifier);
  const nonce = p.kind === "oidc" ? oauthRandom.nonce() : undefined;

  const as = await authorizationServerFor(p);
  const redirectUri = callbackUri(request.url, provider);

  const callerToken = bearerOf(request);
  await ctx.runMutation("auth:_startOAuth", {
    provider, stateHash: sha256base64url(state), codeVerifier, ...(nonce ? { nonce } : {}), redirectTo,
    ...(callerToken ? { callerToken } : {}),
  });

  return redirect(buildAuthorizeUrl(as, p, { redirectUri, state, codeChallenge, ...(nonce ? { nonce } : {}) }));
}
