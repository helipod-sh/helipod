import type { DeployTarget, DeployContext, DeployResult } from "../types";
import { DeployError } from "../types";

/** url/adminKey come from config settings, falling back to the slice-6b env vars (exact back-compat). */
function creds(ctx: DeployContext): { url: string; adminKey: string } {
  const url = String(ctx.target.settings.url ?? process.env.STACKBASE_DEPLOY_URL ?? "").trim();
  const adminKey = String(ctx.target.settings.adminKey ?? process.env.STACKBASE_ADMIN_KEY ?? "").trim();
  return { url, adminKey };
}

export const serveTarget: DeployTarget = {
  name: "serve",
  async preflight(ctx) {
    const { url, adminKey } = creds(ctx);
    if (!url) throw new DeployError("serve target needs a url — pass --url or set deploy.targets.serve settings / STACKBASE_DEPLOY_URL");
    if (!adminKey) throw new DeployError("STACKBASE_ADMIN_KEY is required to deploy to a serve target");
  },
  async package() { /* no artifact to pre-build; files come from ctx.packageApp() at push */ },
  async push(ctx): Promise<DeployResult> {
    const { url, adminKey } = creds(ctx);
    const base = url.replace(/\/$/, "");
    const { files } = await ctx.packageApp();
    let res: Response;
    try {
      res = await fetch(`${base}/_admin/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminKey}` },
        body: JSON.stringify({ files }),
      });
    } catch (e) {
      return { ok: false, error: `could not reach ${base}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (res.status === 404) return { ok: false, error: "deploy not enabled on target (start serve with --allow-deploy)" };
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; rev?: string; functions?: number; error?: string };
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? res.statusText };
    return { ok: true, url: base, detail: `rev ${body.rev} (${body.functions} functions)` };
  },
};
