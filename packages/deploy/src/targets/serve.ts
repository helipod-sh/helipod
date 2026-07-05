import type { DeployTarget, DeployContext, DeployResult } from "../types";
import { DeployError } from "../types";
import { partitionModules } from "../module-hash";

/** url/adminKey come from config settings, falling back to the slice-6b env vars (exact back-compat). */
function creds(ctx: DeployContext): { url: string; adminKey: string } {
  const url = String(ctx.target.settings.url ?? process.env.HELIPOD_DEPLOY_URL ?? "").trim();
  const adminKey = String(ctx.target.settings.adminKey ?? process.env.HELIPOD_ADMIN_KEY ?? "").trim();
  return { url, adminKey };
}

export const serveTarget: DeployTarget = {
  name: "serve",
  async preflight(ctx) {
    const { url, adminKey } = creds(ctx);
    if (!url) throw new DeployError("serve target needs a url — pass --url or set deploy.targets.serve settings / HELIPOD_DEPLOY_URL");
    if (!adminKey) throw new DeployError("HELIPOD_ADMIN_KEY is required to deploy to a serve target");
  },
  async package() { /* no artifact to pre-build; files come from ctx.packageApp() at push */ },
  async push(ctx): Promise<DeployResult> {
    const { url, adminKey } = creds(ctx);
    const base = url.replace(/\/$/, "");
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminKey}` };
    const { files } = await ctx.packageApp();

    // POST helper — returns a normalized shape the flow below branches on.
    const post = async (body: string): Promise<{ ok: boolean; rev?: string; functions?: number; kind?: string; error?: string }> => {
      let res: Response;
      try {
        res = await fetch(`${base}/_admin/deploy`, { method: "POST", headers, body });
      } catch (e) {
        return { ok: false, error: `could not reach ${base}: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (res.status === 404) return { ok: false, error: "deploy not enabled on target (start serve with --allow-deploy)" };
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; rev?: string; functions?: number; kind?: string; error?: string };
      return { ok: Boolean(res.ok && b.ok), rev: b.rev, functions: b.functions, kind: b.kind, error: b.error };
    };
    const done = (r: { rev?: string; functions?: number }, extra: string): DeployResult => ({ ok: true, url: base, detail: `rev ${r.rev} (${r.functions} functions${extra})` });

    // 1. Probe the server's current module hashes (capability + delta base).
    let remoteHashes: Record<string, string> | null = null;
    try {
      const res = await fetch(`${base}/_admin/deploy/modules`, { headers });
      if (res.ok) remoteHashes = (await res.json().catch(() => null)) as Record<string, string> | null;
      // A non-ok (404 old server / disabled) leaves remoteHashes null → full push below.
    } catch {
      // network error surfaces on the POST below
    }

    // 2. Delta push when we have a base; otherwise a full push.
    if (remoteHashes) {
      const { changed, unchanged } = partitionModules({ files }, remoteHashes);
      const r = await post(JSON.stringify({ changed, unchanged }));
      if (r.ok) return done(r, `, ${changed.length} changed`);
      if (r.kind === "stale-base") {
        const full = await post(JSON.stringify({ files }));
        return full.ok ? done(full, ", full retry") : { ok: false, error: full.error ?? "deploy failed" };
      }
      return { ok: false, error: r.error ?? "deploy failed" };
    }
    const r = await post(JSON.stringify({ files }));
    return r.ok ? done(r, "") : { ok: false, error: r.error ?? "deploy failed" };
  },
};
