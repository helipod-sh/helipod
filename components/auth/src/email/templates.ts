export type Flow = "verify" | "reset" | "magic" | "otp";
export interface TemplateArgs { appName: string; email: string; code?: string; url?: string; ttlMs: number }
export interface RenderedEmail { subject: string; text: string; html?: string }
export type TemplateFn = (a: TemplateArgs) => RenderedEmail;
export type EmailTemplates = Record<Flow, TemplateFn>;

const minutes = (ms: number) => Math.round(ms / 60000);
export const defaultTemplates: EmailTemplates = {
  verify: (a) => ({ subject: `Verify your ${a.appName} email`,
    text: `Confirm your email for ${a.appName}:\n\n${a.url}\n\nThis link expires in ${minutes(a.ttlMs)} minutes.` }),
  reset: (a) => ({ subject: `Reset your ${a.appName} password`,
    text: `Reset your ${a.appName} password:\n\n${a.url}\n\nThis link expires in ${minutes(a.ttlMs)} minutes. If you didn't request this, ignore this email.` }),
  magic: (a) => ({ subject: `Sign in to ${a.appName}`,
    text: `Sign in to ${a.appName}:\n\n${a.url}\n\nThis link expires in ${minutes(a.ttlMs)} minutes.` }),
  otp: (a) => ({ subject: `Your ${a.appName} sign-in code`,
    text: `Your ${a.appName} sign-in code is:\n\n${a.code}\n\nIt expires in ${minutes(a.ttlMs)} minutes.` }),
};

export function resolveTemplates(overrides?: Partial<EmailTemplates>): EmailTemplates {
  return { ...defaultTemplates, ...(overrides ?? {}) };
}
