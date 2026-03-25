import { mutation, action, httpAction, type ActionCtx, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { AuthConfig } from "./config";
import type { OAuthProvider } from "./oauth";
import { authorizationServerFor, buildAuthorizeUrl, isAllowedRedirect, callbackUri, resolveProvider } from "./oauth";
import { resolveSession, mintSession, normalizeEmail, markVerifiedRevokingIfFirstProof, type MintResult } from "./functions";
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
    modules._resolveExternalIdentity = resolveExternalIdentityMutation(config);
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

// ───────────────────── Part 3: resolution/linking matrix (Task 4) ─────────────────────

/** Part-3 shared resolution + linking + (optional) mint, called by the OAuth callback (mint deferred
 *  to the handoff → `outcome:"handoff"`) and by `signInWithIdToken` (mint here → `outcome:"mint"`).
 *  No ephemeral consume happens here, so no commitThenThrow — the consume/validate lives in the
 *  callers (`_consumeOAuthState`/`_consumeHandoff`). */
function resolveExternalIdentityMutation(config: AuthConfig) {
  return mutation(async (ctx, args: {
    provider: string; accountId: string; email?: string; emailVerified: boolean;
    linkUserId?: string; deviceLabel?: string; outcome: "handoff" | "mint"; handoffHash?: string;
  }): Promise<{ userId: string } | MintResult> => {
    const now = ctx.now();
    const userId = await resolveUserId(ctx, args);
    if (args.outcome === "mint") return mintSession(ctx, config, userId, args.deviceLabel);
    // outcome === "handoff": authorize a mint for `userId` (holds NO token); the httpAction has the raw code.
    // Invariant: "handoff" is OAuth-only (JWT's `signInWithIdToken` only ever sends "mint"). Guard the
    // non-null assertion below with a clear internal error instead of letting a JWT-only deployment
    // (config.oauth undefined) hit a raw TypeError if this invariant is ever broken by a future caller.
    if (!config.oauth) throw new Error("_resolveExternalIdentity: outcome:\"handoff\" requires config.oauth (JWT-only deployments must only send outcome:\"mint\")");
    await ctx.db.insert("oauthHandoff", compact({
      handoffHash: args.handoffHash!, userId,
      deviceLabelHint: args.deviceLabel,
      expiresAt: now + config.oauth.handoffTtlMs, createdAt: now,
    }));
    return { userId };
  });
}

/** The Part-3 decision tree. Returns the resolved `userId`, performing all link/provision/revoke
 *  writes. Attribution: verified-email-required-for-autolink + trusted-link-while-signed-in adapted
 *  from `.reference/convex-auth` (Apache-2.0) + `.reference/better-auth` (MIT); the flip-gated session
 *  wipe on a verified-email link is A2's first-mailbox-proof rule (the shared `markVerifiedRevokingIfFirstProof`). */
async function resolveUserId(ctx: MutationCtx, args: { provider: string; accountId: string; email?: string; emailVerified: boolean; linkUserId?: string }): Promise<string> {
  // 1) Returning identity — this external account is already bound.
  const [existing] = await ctx.db.query("accounts", "byAccount").eq("provider", args.provider).eq("accountId", args.accountId).collect();
  if (existing) return existing.userId as string;

  // 2) Link-while-signed-in — the caller proved both the session AND the external identity.
  if (args.linkUserId) {
    const u = await ctx.db.get(args.linkUserId);
    if (u) { await insertExternalAccount(ctx, args.linkUserId, args.provider, args.accountId); return args.linkUserId; }
    // stale/invalid linkUserId → fall through to email-based resolution
  }

  const normEmail = args.email ? normalizeEmail(args.email) : undefined;

  // 3) VERIFIED email that matches an existing user — LINK + first-mailbox-proof (FLIP-GATED). Add the
  //    external account, then `markVerifiedRevokingIfFirstProof` (the SAME helper A2 uses): it wipes the
  //    user's sessions ONLY on the emailVerified false→true flip, then sets emailVerified:true. Takeover
  //    defense — a pre-registrant's parked UNVERIFIED account flips here, killing the attacker's parked
  //    sessions; an already-verified user legitimately adding a second provider has NO flip, so their
  //    other-device sessions survive (better UX, still safe: the account was already proven to be theirs).
  if (normEmail && args.emailVerified === true) {
    const [user] = await ctx.db.query("users", "byEmail").eq("email", normEmail).collect();
    if (user) {
      await insertExternalAccount(ctx, user._id as string, args.provider, args.accountId);
      await markVerifiedRevokingIfFirstProof(ctx, user as Record<string, unknown>);
      return user._id as string;
    }
  }

  // 4) No verified-email match (or unverified / no email) — NEVER auto-link. Create a NEW user.
  const userId = (await ctx.db.insert("users", compact({
    email: normEmail, emailVerified: args.emailVerified === true ? true : undefined,
  }))) as string;
  await insertExternalAccount(ctx, userId, args.provider, args.accountId);
  return userId;
}

/** Insert an external (`google`/`github`/`oidc:<issuer>`) `accounts` row. `secret:""` is an unused
 *  sentinel (accounts.secret is a required v.string(); password signIn only ever queries
 *  provider:"password", so it never reads this) — keeps `accounts` additive with no schema change. */
async function insertExternalAccount(ctx: MutationCtx, userId: string, provider: string, accountId: string): Promise<void> {
  await ctx.db.insert("accounts", { userId, provider, accountId, secret: "", failedAttempts: 0, lockedUntil: 0 });
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
