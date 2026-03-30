import { mutation, action, httpAction, commitThenThrow, type ActionCtx, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { AuthConfig } from "./config";
import type { OAuthProvider } from "./oauth";
import { authorizationServerFor, buildAuthorizeUrl, isAllowedRedirect, callbackUri, resolveProvider, exchangeAndExtractIdentity } from "./oauth";
import { resolveSession, mintSession, normalizeEmail, markVerifiedRevokingIfFirstProof, type MintResult } from "./functions";
import { sha256base64url, generateToken } from "./crypto";
import { verifyIdToken } from "./jwt";
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
    modules._consumeOAuthState = _consumeOAuthState();
    modules._consumeHandoff = _consumeHandoff(config);
    modules.completeOAuthSignIn = completeOAuthSignIn();
    modules.oauthHttp = oauthHttp(config);
  }

  if (config.jwt) {
    modules.signInWithIdToken = signInWithIdToken(config);
  }

  return modules;
}

// ─────────────────────────── Third-party JWT `signInWithIdToken` (Task 6) ───────────────────────────

/** Verify a third-party (Clerk/Auth0/any OIDC issuer) id_token via jose live JWKS fetch (signature +
 *  `iss` allowlist + `aud` + `exp`/`nbf`), then delegate to the SAME Part-3 core the OAuth callback
 *  uses (`_resolveExternalIdentity`) with `outcome:"mint"` — this is the exchange model: a short-lived
 *  third-party token is verified once and traded directly for a Stackbase session (no browser
 *  redirect/handoff needed, since the client called this action directly and gets the mint result
 *  back). JIT-provision (a first-sight `oidc:<issuer>` identity becomes a fresh local user) and
 *  account-linking (a verified-email match) compose automatically since it is the same core Task 4/5
 *  share. Every verification failure surfaces GENERIC — no unknown-kid/bad-signature/wrong-aud/expired/
 *  wrong-iss distinction (no enumeration). */
function signInWithIdToken(config: AuthConfig) {
  return action(async (ctx, { idToken, deviceLabel }: { idToken: string; deviceLabel?: string }): Promise<MintResult> => {
    let v;
    try { v = await verifyIdToken(idToken, config.jwt!); }
    catch { throw new Error(GENERIC); }
    if (!v.sub) throw new Error(GENERIC);
    return (ctx as ActionCtx).runMutation<MintResult>("auth:_resolveExternalIdentity", {
      provider: `oidc:${v.issuer}`, accountId: v.sub,
      // `emailVerified` is ALREADY a strict boolean from `verifyIdToken` (`=== true`, never a
      // truthy/string coercion — the STRICT-BOOLEAN CARRY-FORWARD); passed straight through, and the
      // T4 core itself re-asserts `=== true` at the gate (defense in depth).
      ...(v.email ? { email: v.email } : {}), emailVerified: v.emailVerified,
      ...(deviceLabel ? { deviceLabel } : {}), outcome: "mint",
    });
  });
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

    if (phase === "start") {
      // GET-only, defense in depth: the POST route entry exists so `callback` can accept Apple's
      // form_post, but oauthStart today only reads the query string + Authorization header. A non-GET
      // here is fully generic (same 404 as an unresolved provider) — no method-specific leak.
      if (request.method !== "GET") return fail(404);
      return oauthStart(ctx as ActionCtx, config, request, url, provider, p);
    }
    if (phase === "callback") return oauthCallback(ctx as ActionCtx, config, request, url, provider, p);
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

// ─────────────────────────── OAuth `/callback` + handoff + completeOAuthSignIn (Task 5) ───────────────────────────

/** The `callback` phase of `oauthHttp`: consume state (single-use), exchange the code, extract the
 *  normalized identity, resolve/link/provision/revoke via the shared Part-3 core, then authorize a
 *  mint via a fresh `oauthHandoff` row and 302 to `redirectTo#code=<handoff>` (fragment, never query —
 *  fragments aren't sent to servers or logged in Referer). Every failure surfaces generic (no
 *  enumeration): a missing/tampered/replayed `state`, a provider protocol failure, or an exchange
 *  error all collapse to the same `fail(400)`. */
async function oauthCallback(ctx: ActionCtx, config: AuthConfig, request: Request, url: URL, provider: string, p: OAuthProvider): Promise<Response> {
  // Collect the authorization-response params from EITHER the GET query OR (Apple `form_post`) the
  // urlencoded POST body. Both converge on a single URLSearchParams handed to `validateAuthResponse`
  // and the exchange. The POST body is NOT a new trust source: it carries the same code/state/id_token
  // a GET would, plus a COSMETIC `user` JSON (first-auth display name only — never identity; decision 1).
  let params: URLSearchParams;
  let extra: { user?: { name?: { firstName?: string; lastName?: string }; email?: string } } | undefined;
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    if (!ct.includes("application/x-www-form-urlencoded")) return fail(400);
    let bodyText: string;
    try { bodyText = await request.text(); } catch { return fail(400); }
    params = new URLSearchParams(bodyText);
    const userRaw = params.get("user");
    if (userRaw) {
      // Apple sends `user` ONCE (first authorization). Parse defensively for the cosmetic name only —
      // a malformed value is ignored, never fatal, and NEVER read for email/identity.
      try {
        const parsed = JSON.parse(userRaw) as { name?: { firstName?: string; lastName?: string }; email?: string };
        extra = { user: parsed };
      } catch { /* cosmetic-only — ignore */ }
    }
  } else {
    params = url.searchParams;
  }

  const state = params.get("state");
  if (!state) return fail(400);

  // Consume-before-validate: `_consumeOAuthState` deletes the row FIRST, then validates provider/expiry
  // (commitThenThrow on any post-consume throw). A miss/mismatch/replay → generic 400. This CSRF/replay
  // defense is transport-agnostic — a replayed POST callback with a consumed state 400s exactly like GET.
  let recovered: { codeVerifier: string; nonce?: string; redirectTo: string; linkUserId?: string };
  try {
    recovered = await ctx.runMutation("auth:_consumeOAuthState", { provider, stateHash: sha256base64url(state) });
  } catch { return fail(400); }

  // Re-validate redirectTo against the allowlist (defense in depth), BEFORE any exchange/resolve write.
  if (!isAllowedRedirect(recovered.redirectTo, config.oauth!.redirectAllowlist)) return fail(400);

  // Exchange + extract identity. oauth4webapi validates state (validateAuthResponse) + nonce
  // (processAuthorizationCodeResponse). Identity derives ONLY from the verified id_token; `extra` (the
  // cosmetic `user` JSON) is threaded to the mapper for a display name only. Any protocol failure →
  // generic 400 (no enumeration).
  let identity;
  try {
    const as = await authorizationServerFor(p);
    const client: oauth.Client = { client_id: p.clientId };
    const validated = oauth.validateAuthResponse(as, client, params, state);
    identity = await exchangeAndExtractIdentity({
      as, provider: p, params: validated, redirectUri: callbackUri(request.url, provider),
      codeVerifier: recovered.codeVerifier, ...(recovered.nonce ? { nonce: recovered.nonce } : {}),
      ...(extra ? { extra } : {}),
    });
  } catch { return fail(400); }

  // Resolve + link + revoke, and authorize a mint via a fresh handoff (holds NO token). `emailVerified`
  // is ALREADY a strict boolean by construction (every `mapClaims` — default/google/github — computes
  // it via `=== true`, never a truthy/string coercion; see `ExternalIdentity`), so it is passed straight
  // through to the T4 core, which itself re-asserts `=== true` at the gate (defense in depth).
  const handoff = generateToken();
  await ctx.runMutation("auth:_resolveExternalIdentity", {
    provider, accountId: identity.accountId,
    ...(identity.email ? { email: identity.email } : {}), emailVerified: identity.emailVerified === true,
    ...(recovered.linkUserId ? { linkUserId: recovered.linkUserId } : {}),
    outcome: "handoff", handoffHash: sha256base64url(handoff),
  });

  // 302 to redirectTo with the one-time handoff in the FRAGMENT (never the query — fragments aren't
  // sent to servers or logged in Referer). Only a one-time code transits; tokens never do.
  const target = new URL(recovered.redirectTo);
  target.hash = `code=${handoff}`;
  return redirect(target.toString());
}

/** Consume-before-validate the state row. Miss → plain throw (nothing consumed). Found → delete
 *  (consume), then validate provider + expiry; any failure after the delete → commitThenThrow so the
 *  consume commits (single-winner under single-writer OCC). */
function _consumeOAuthState() {
  return mutation(async (ctx, { provider, stateHash }: { provider: string; stateHash: string }): Promise<{ codeVerifier: string; nonce?: string; redirectTo: string; linkUserId?: string } | ReturnType<typeof commitThenThrow>> => {
    const [row] = await ctx.db.query("oauthState", "byStateHash").eq("stateHash", stateHash).collect();
    if (!row) throw new Error(GENERIC);                       // nothing consumed
    await ctx.db.delete(row._id as string);                   // consume
    if ((row.provider as string) !== provider || ctx.now() > (row.expiresAt as number)) return commitThenThrow(GENERIC);
    return {
      codeVerifier: row.codeVerifier as string,
      ...(row.nonce !== undefined ? { nonce: row.nonce as string } : {}),
      redirectTo: row.redirectTo as string,
      ...(row.linkUserId !== undefined ? { linkUserId: row.linkUserId as string } : {}),
    };
  });
}

/** Exchange the handoff for the mint — consume-before-validate, then mint (A1 chokepoint). */
function _consumeHandoff(config: AuthConfig) {
  return mutation(async (ctx, { handoffCode }: { handoffCode: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    const handoffHash = sha256base64url(handoffCode);
    const [row] = await ctx.db.query("oauthHandoff", "byHandoffHash").eq("handoffHash", handoffHash).collect();
    if (!row) throw new Error(GENERIC);
    await ctx.db.delete(row._id as string);                   // consume
    if (ctx.now() > (row.expiresAt as number)) return commitThenThrow(GENERIC);
    return mintSession(ctx, config, row.userId as string, row.deviceLabelHint as string | undefined);
  });
}

/** The app calls this after reading `#code=<handoff>` off the redirect fragment. Mints THEN (tokens
 *  returned directly, never stored). */
function completeOAuthSignIn() {
  return action(async (ctx, { handoffCode }: { handoffCode: string }): Promise<MintResult> => {
    return (ctx as ActionCtx).runMutation<MintResult>("auth:_consumeHandoff", { handoffCode });
  });
}
