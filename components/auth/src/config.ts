import type { EmailProvider } from "./email/provider";
import { resolveTemplates, type EmailTemplates } from "./email/templates";
import type { OAuthProvider } from "./oauth";
import { assertProviderEndpointsSecure, assertUrlIsSecure } from "./oauth";
import { decodeKeyMaterial, type MfaKey } from "./mfa/secret-crypto";

/** Resolved email config (all defaults applied). Present iff a project passed `email` with a provider. */
export interface EmailConfig {
  provider: EmailProvider;
  from: string;
  appName: string;
  baseUrl?: string;
  otpAttempts: number;
  otpTtlMs: number;
  magicLinkTtlMs: number;
  resetTtlMs: number;
  verifyTtlMs: number;
  requestCooldownMs: number;
  emailSendsPerMinute: number;
  requireEmailVerification: boolean;
  createUsersOnEmailSignIn: boolean;
  templates: EmailTemplates;
  /** N4 auth-unification: the `category` passed to a composed `@stackbase/notifications`' `send`
   *  (preferences/criticality key on that side). Defaults to `"auth"`. Irrelevant when no
   *  notifications component is composed (the `e.provider.send` fallback ignores it). */
  notificationCategory: string;
}

/** Resolved OAuth config (defaults applied). Present iff `defineAuth({ oauth })` was passed. There is
 *  NO `allowInsecureRequests` field — insecure-http is derived per-endpoint (loopback-only) at request
 *  time, and a non-loopback http:// provider is rejected in `resolveOAuthConfig`. */
export interface OAuthConfig {
  providers: Record<string, OAuthProvider>;
  redirectAllowlist: string[];
  stateTtlMs: number;
  handoffTtlMs: number;
}
/** Resolved third-party-JWT config. Present iff `defineAuth({ jwt })` was passed. */
export interface JwtConfig {
  issuers: Array<{ issuer: string; audience: string; jwksUrl?: string }>;
}
export interface OAuthOptions {
  providers: Record<string, OAuthProvider>;
  redirectAllowlist: string[];
  stateTtlMs?: number;
  handoffTtlMs?: number;
}
export interface JwtOptions {
  issuers: Array<{ issuer: string; audience: string; jwksUrl?: string }>;
}

/** Resolved MFA config. Present iff `defineAuth({ mfa })` was passed with a usable key —
 *  absence of a valid 32-byte key FAILS FAST in `resolveAuthConfig` (never silently at first
 *  use). `keyring[0]` is the primary key (used for new encryptions); decryption dispatches on
 *  the envelope's stored `keyId` against the whole keyring (rotation support). */
export interface MfaConfig {
  keyring: MfaKey[];
  issuer: string;
  recoveryCodeCount: number;
  challengeTtlMs: number;
  mfaAttempts: number;
  window: number;
  /** Fixed in the v1 config surface (spec decision 1) — stored per-enrollment, not an app knob. */
  algorithm: "SHA1";
  digits: number;
  period: number;
}
/** The user-facing `mfa` block. Exactly one key source is required — `encryptionKey` (a single
 *  32-byte key, base64 or hex) or `encryptionKeys` (an ordered keyring for rotation, `[0]`
 *  primary). Everything else is optional-with-defaults. */
export interface MfaOptions {
  encryptionKey?: string;
  encryptionKeys?: Array<{ id: string; key: string }>;
  issuer?: string;
  recoveryCodeCount?: number;
  challengeTtlMs?: number;
  mfaAttempts?: number;
  window?: number;
}

/** The user-facing `email` block: `provider` + `from` required, everything else optional-with-defaults. */
export interface EmailOptions {
  provider: EmailProvider;
  from: string;
  appName?: string;
  baseUrl?: string;
  otpAttempts?: number;
  otpTtlMs?: number;
  magicLinkTtlMs?: number;
  resetTtlMs?: number;
  verifyTtlMs?: number;
  requestCooldownMs?: number;
  emailSendsPerMinute?: number;
  requireEmailVerification?: boolean;
  createUsersOnEmailSignIn?: boolean;
  templates?: Partial<EmailTemplates>;
  /** N4 auth-unification: the `category` auth passes to a composed `@stackbase/notifications`'
   *  `send` when routing through it (default `"auth"`). Has no effect on the no-notifications
   *  fallback (`e.provider.send` doesn't take a category). */
  notificationCategory?: string;
}

/** Auth component configuration (spec "Component surface"). All fields have defaults; a project
 *  overrides any subset via `defineAuth({ ... })`. */
export interface AuthConfig {
  /** Access-token lifetime (default 1h). Bounds how long a stolen access token is usable. */
  accessTtlMs: number;
  /** Refresh-token lifetime, sliding on each rotation (default 30d). */
  refreshTtlMs: number;
  /** Grace window: a previous-hash replay within this of `lastRefreshAt` is a soft `REFRESH_STALE`,
   *  not a theft signal (default 30s). */
  refreshGraceMs: number;
  /** Absolute session ceiling, fixed at mint, never slides (default 90d). */
  sessionTotalTtlMs: number;
  /** Deployment-global cap on anonymous user creation per minute; `0` disables anonymous throttling
   *  (default 60). */
  anonymousSignInsPerMinute: number;
  /** Present iff a project configured `email` (with a provider) — absent ⇒ A2 flows are unregistered. */
  email?: EmailConfig;
  /** Present iff a project configured `oauth` — absent ⇒ A3 OAuth routes/functions are unregistered. */
  oauth?: OAuthConfig;
  /** Present iff a project configured `jwt` — absent ⇒ `signInWithIdToken` is unregistered. */
  jwt?: JwtConfig;
  /** Present iff a project configured `mfa` with a usable key — absent ⇒ MFA is fully unregistered
   *  and every gated first-factor path mints directly (byte-identical to a pre-MFA deployment). */
  mfa?: MfaConfig;
}

export type AuthOptions = Partial<Omit<AuthConfig, "email" | "oauth" | "jwt" | "mfa">> & {
  email?: EmailOptions;
  oauth?: OAuthOptions;
  jwt?: JwtOptions;
  mfa?: MfaOptions;
};

const DEFAULTS: Omit<AuthConfig, "email"> = {
  accessTtlMs: 60 * 60 * 1000,
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  refreshGraceMs: 30_000,
  sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000,
  anonymousSignInsPerMinute: 60,
};

const EMAIL_DEFAULTS = {
  appName: "Stackbase app",
  otpAttempts: 5,
  otpTtlMs: 10 * 60 * 1000,
  magicLinkTtlMs: 60 * 60 * 1000,
  resetTtlMs: 60 * 60 * 1000,
  verifyTtlMs: 24 * 60 * 60 * 1000,
  requestCooldownMs: 60_000,
  emailSendsPerMinute: 100,
  requireEmailVerification: false,
  createUsersOnEmailSignIn: true,
};

function resolveEmailConfig(opts: EmailOptions): EmailConfig {
  return {
    provider: opts.provider,
    from: opts.from,
    appName: opts.appName ?? EMAIL_DEFAULTS.appName,
    baseUrl: opts.baseUrl,
    otpAttempts: opts.otpAttempts ?? EMAIL_DEFAULTS.otpAttempts,
    otpTtlMs: opts.otpTtlMs ?? EMAIL_DEFAULTS.otpTtlMs,
    magicLinkTtlMs: opts.magicLinkTtlMs ?? EMAIL_DEFAULTS.magicLinkTtlMs,
    resetTtlMs: opts.resetTtlMs ?? EMAIL_DEFAULTS.resetTtlMs,
    verifyTtlMs: opts.verifyTtlMs ?? EMAIL_DEFAULTS.verifyTtlMs,
    requestCooldownMs: opts.requestCooldownMs ?? EMAIL_DEFAULTS.requestCooldownMs,
    emailSendsPerMinute: opts.emailSendsPerMinute ?? EMAIL_DEFAULTS.emailSendsPerMinute,
    requireEmailVerification: opts.requireEmailVerification ?? EMAIL_DEFAULTS.requireEmailVerification,
    createUsersOnEmailSignIn: opts.createUsersOnEmailSignIn ?? EMAIL_DEFAULTS.createUsersOnEmailSignIn,
    templates: resolveTemplates(opts.templates), // merge partial overrides onto defaults
    notificationCategory: opts.notificationCategory ?? "auth",
  };
}

const OAUTH_DEFAULTS = { stateTtlMs: 10 * 60 * 1000, handoffTtlMs: 2 * 60 * 1000 };

function resolveOAuthConfig(opts: OAuthOptions): OAuthConfig {
  if (!opts.redirectAllowlist || opts.redirectAllowlist.length === 0) {
    throw new Error("defineAuth({ oauth }) requires a non-empty redirectAllowlist (open-redirect guard)");
  }
  // Reject a non-loopback http:// provider endpoint at config time (MITM risk on OAuth — a path
  // attacker could forge the token/id_token). https always fine; http tolerated ONLY on loopback
  // (127.0.0.1/localhost/::1). Insecure-http is DERIVED per-endpoint at request time — there is no
  // app-settable flag to weaken this.
  for (const [name, p] of Object.entries(opts.providers)) assertProviderEndpointsSecure(name, p);
  return {
    providers: opts.providers,
    redirectAllowlist: opts.redirectAllowlist,
    stateTtlMs: opts.stateTtlMs ?? OAUTH_DEFAULTS.stateTtlMs,
    handoffTtlMs: opts.handoffTtlMs ?? OAUTH_DEFAULTS.handoffTtlMs,
  };
}

/** Same MITM class as OAuth (T2), ported to the third-party-JWT config path: a plain-http JWT
 *  issuer/JWKS endpoint lets a network-position attacker serve a FORGED JWKS (their own public key)
 *  over the plaintext fetch `verifyIdToken`/`jwksFor` makes, then mint a JWT signed with that key —
 *  `iss`/`aud` are never secret, so `jwtVerify` accepts it outright. Reject a non-loopback `http://`
 *  `issuer` AND, if given, `jwksUrl` (the JWKS URL actually fetched — when `jwksUrl` is omitted,
 *  `verifyIdToken` derives it from `issuer`'s own origin, so validating `issuer` alone already covers
 *  that case). `https://` is always fine; loopback `http://` (127.0.0.1/localhost/::1) stays allowed
 *  for the E2E mock issuer + local dev. Reuses `assertUrlIsSecure` — the exact predicate OAuth's
 *  `assertProviderEndpointsSecure` uses — rather than reimplementing the loopback gate a third time. */
function resolveJwtConfig(opts: JwtOptions): JwtConfig {
  if (!opts.issuers || opts.issuers.length === 0) {
    throw new Error("defineAuth({ jwt }) requires a non-empty issuers array");
  }
  opts.issuers.forEach((cfg, i) => {
    assertUrlIsSecure(`jwt issuers[${i}].issuer`, cfg.issuer);
    if (cfg.jwksUrl) assertUrlIsSecure(`jwt issuers[${i}].jwksUrl`, cfg.jwksUrl);
  });
  return { issuers: opts.issuers };
}

const MFA_DEFAULTS = {
  issuer: "Stackbase",
  recoveryCodeCount: 10,
  challengeTtlMs: 5 * 60 * 1000,
  mfaAttempts: 5,
  window: 1,
  // Fixed in v1 (spec decision 1) — not app-configurable knobs, just the shared default stamped
  // onto every new enrollment's `algorithm`/`digits`/`period` fields.
  algorithm: "SHA1" as const,
  digits: 6,
  period: 30,
};

/** Decode + validate the MFA key source into an ordered keyring (`[0]` primary) and apply
 *  defaults. Throws (fail-fast, called from `resolveAuthConfig` — never deferred to first use)
 *  when `mfa` is configured but no usable 32-byte key is present, or when a given key is the
 *  wrong length (via `decodeKeyMaterial`, which throws its own message). */
export function resolveMfaConfig(opts: MfaOptions): MfaConfig {
  let keyring: MfaKey[];
  if (opts.encryptionKeys && opts.encryptionKeys.length > 0) {
    keyring = opts.encryptionKeys.map((k) => ({ id: k.id, key: decodeKeyMaterial(k.key) }));
  } else if (opts.encryptionKey) {
    keyring = [{ id: "1", key: decodeKeyMaterial(opts.encryptionKey) }];
  } else {
    throw new Error("defineAuth({ mfa }) requires a 32-byte encryptionKey or encryptionKeys");
  }
  return {
    keyring,
    issuer: opts.issuer ?? MFA_DEFAULTS.issuer,
    recoveryCodeCount: opts.recoveryCodeCount ?? MFA_DEFAULTS.recoveryCodeCount,
    challengeTtlMs: opts.challengeTtlMs ?? MFA_DEFAULTS.challengeTtlMs,
    mfaAttempts: opts.mfaAttempts ?? MFA_DEFAULTS.mfaAttempts,
    window: opts.window ?? MFA_DEFAULTS.window,
    algorithm: MFA_DEFAULTS.algorithm,
    digits: MFA_DEFAULTS.digits,
    period: MFA_DEFAULTS.period,
  };
}

export function resolveAuthConfig(opts?: AuthOptions): AuthConfig {
  const { email, oauth, jwt, mfa, ...rest } = opts ?? {};
  const base: AuthConfig = { ...DEFAULTS, ...rest };
  if (email) base.email = resolveEmailConfig(email);
  if (oauth) base.oauth = resolveOAuthConfig(oauth);
  if (jwt) base.jwt = resolveJwtConfig(jwt);
  if (mfa) base.mfa = resolveMfaConfig(mfa);
  return base;
}
