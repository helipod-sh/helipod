/**
 * `stackbase migrate export` / `stackbase migrate import` — move an app's DATA between the two
 * storage topologies (portable container+R2 / SQLite / Postgres ⇄ Cloudflare DO-native DO-SQLite).
 * Slice 5 of the DO-native host program.
 *
 * These are HTTP clients (modelled on `deploy.ts`) that hit a RUNNING source/target deployment's
 * admin endpoints — `GET /_admin/export` and `POST /_admin/import`, bearer-gated by
 * `STACKBASE_ADMIN_KEY`. Both the container `serve` path and the Cloudflare DO host expose those
 * routes (both funnel `/_admin/*` through the same handler), so one client migrates in either
 * direction; the DO can ONLY be reached over HTTP, which is why an HTTP-first client is the coherent
 * shape. A stopped plain-SQLite source is exported by pointing a throwaway `serve`/`dev` at it first.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface DataMigrateOptions {
  url: string;
  file: string; // --out for export, --in for import
  adminKey: string;
}

function resolveOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  fileFlag: "--out" | "--in",
): DataMigrateOptions | { error: string } {
  let url = "";
  let file = "";
  let adminKey = env.STACKBASE_ADMIN_KEY?.trim() ?? "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url" && args[i + 1]) url = args[++i]!;
    else if (a === fileFlag && args[i + 1]) file = args[++i]!;
    else if (a === "--admin-key" && args[i + 1]) adminKey = args[++i]!;
  }
  if (!url) return { error: "missing target URL — pass --url <url>" };
  if (!file) return { error: `missing ${fileFlag} <file>` };
  if (!adminKey) return { error: "STACKBASE_ADMIN_KEY is required (or pass --admin-key)" };
  return { url, file, adminKey };
}

/** `stackbase migrate export --url <src> --out dump.json` — pull the source's full state to a file. */
export async function migrateExportCommand(args: string[]): Promise<number> {
  const opts = resolveOptions(args, process.env, "--out");
  if ("error" in opts) {
    process.stderr.write(`✗ ${opts.error}\n`);
    return 1;
  }
  let res: Response;
  try {
    res = await fetch(`${opts.url.replace(/\/$/, "")}/_admin/export`, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.adminKey}` },
    });
  } catch (e) {
    process.stderr.write(`✗ could not reach ${opts.url}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (res.status === 401) {
    process.stderr.write("✗ unauthorized — check STACKBASE_ADMIN_KEY / --admin-key\n");
    return 1;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    process.stderr.write(`✗ export failed: ${body.error ?? res.statusText}\n`);
    return 1;
  }
  const dumpText = await res.text();
  writeFileSync(opts.file, dumpText);
  const dump = JSON.parse(dumpText) as { documents?: unknown[]; indexUpdates?: unknown[] };
  process.stdout.write(
    `✓ exported ${dump.documents?.length ?? 0} documents, ${dump.indexUpdates?.length ?? 0} index rows → ${opts.file}\n`,
  );
  return 0;
}

/** `stackbase migrate import --url <dst> --in dump.json` — push a dump into the target (fresh). */
export async function migrateImportCommand(args: string[]): Promise<number> {
  const opts = resolveOptions(args, process.env, "--in");
  if ("error" in opts) {
    process.stderr.write(`✗ ${opts.error}\n`);
    return 1;
  }
  let dumpText: string;
  try {
    dumpText = readFileSync(opts.file, "utf8");
  } catch (e) {
    process.stderr.write(`✗ could not read ${opts.file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  let res: Response;
  try {
    res = await fetch(`${opts.url.replace(/\/$/, "")}/_admin/import`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.adminKey}` },
      body: dumpText,
    });
  } catch (e) {
    process.stderr.write(`✗ could not reach ${opts.url}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (res.status === 401) {
    process.stderr.write("✗ unauthorized — check STACKBASE_ADMIN_KEY / --admin-key\n");
    return 1;
  }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    imported?: { documents: number; indexUpdates: number };
    error?: string;
  };
  if (!res.ok || !body.ok) {
    // A table-number collision guard rejection (or a malformed dump) lands here with a clear message.
    process.stderr.write(`✗ import failed: ${body.error ?? res.statusText}\n`);
    return 1;
  }
  process.stdout.write(
    `✓ imported ${body.imported?.documents ?? 0} documents, ${body.imported?.indexUpdates ?? 0} index rows\n`,
  );
  return 0;
}
