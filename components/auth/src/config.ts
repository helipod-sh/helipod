import type { EmailProvider } from "./email/provider";
import { resolveTemplates, type EmailTemplates } from "./email/templates";
import type { OAuthProvider } from "./oauth";
import { assertProviderEndpointsSecure } from "./oauth";

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
}

export type AuthOptions = Partial<Omit<AuthConfig, "email" | "oauth" | "jwt">> & {
  email?: EmailOptions;
  oauth?: OAuthOptions;
  jwt?: JwtOptions;
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

export function resolveAuthConfig(opts?: AuthOptions): AuthConfig {
  const { email, oauth, jwt, ...rest } = opts ?? {};
  const base: AuthConfig = { ...DEFAULTS, ...rest };
  if (email) base.email = resolveEmailConfig(email);
  if (oauth) base.oauth = resolveOAuthConfig(oauth);
  if (jwt) base.jwt = { issuers: jwt.issuers };
  return base;
}
