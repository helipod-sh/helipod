/** String-aware JSONC → JSON: strips // and block comments and trailing commas, honoring string literals. */
export function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  let strQuote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if (c === strQuote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strQuote = c; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // Remove trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const DO_BINDING = "STACKBASE_DO";
const DO_CLASS = "StackbaseDO";
const R2_BINDING = "STORAGE_BUCKET";
const COMPAT_FLAG = "nodejs_compat";

export interface ReconcileOpts { needsR2?: boolean; r2BucketName?: string; }
export interface ReconcileResult { config: Record<string, unknown>; changed: boolean; added: string[]; }

/** Additively ensure the Stackbase DO bindings/migration/compat flag (+ optional R2) exist. Never
 *  drops a user field. Returns a fresh config object; `changed` says whether anything was added. */
export function reconcileWrangler(input: Record<string, unknown>, opts: ReconcileOpts): ReconcileResult {
  const config: Record<string, unknown> = structuredClone(input);
  const added: string[] = [];

  // Durable Object binding
  const dobj = (config.durable_objects ??= {}) as { bindings?: Array<{ name: string; class_name: string }> };
  dobj.bindings ??= [];
  if (!dobj.bindings.some((b) => b.name === DO_BINDING)) {
    dobj.bindings.push({ name: DO_BINDING, class_name: DO_CLASS });
    added.push(`durable_objects.${DO_BINDING}`);
  }

  // SQLite class migration
  const migrations = (config.migrations ??= []) as Array<{ tag: string; new_sqlite_classes?: string[] }>;
  const hasSqliteClass = migrations.some((m) => m.new_sqlite_classes?.includes(DO_CLASS));
  if (!hasSqliteClass) {
    migrations.push({ tag: `v${migrations.length + 1}`, new_sqlite_classes: [DO_CLASS] });
    added.push(`migrations.${DO_CLASS}`);
  }

  // nodejs_compat flag
  const flags = (config.compatibility_flags ??= []) as string[];
  if (!flags.includes(COMPAT_FLAG)) { flags.push(COMPAT_FLAG); added.push(`compatibility_flags.${COMPAT_FLAG}`); }

  // Optional R2 bucket (file storage)
  if (opts.needsR2) {
    const buckets = (config.r2_buckets ??= []) as Array<{ binding: string; bucket_name: string }>;
    if (!buckets.some((b) => b.binding === R2_BINDING)) {
      buckets.push({ binding: R2_BINDING, bucket_name: opts.r2BucketName ?? "stackbase-storage" });
      added.push(`r2_buckets.${R2_BINDING}`);
    }
  }

  return { config, changed: added.length > 0, added };
}
