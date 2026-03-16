import type { EmailProvider } from "./email/provider";
import { resolveTemplates, type EmailTemplates } from "./email/templates";

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
}

export type AuthOptions = Partial<Omit<AuthConfig, "email">> & { email?: EmailOptions };

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

export function resolveAuthConfig(opts?: AuthOptions): AuthConfig {
  const { email, ...rest } = opts ?? {};
  const base: AuthConfig = { ...DEFAULTS, ...rest };
  if (email) base.email = resolveEmailConfig(email);
  return base;
}
