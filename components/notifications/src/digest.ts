import { mutation, query, GuestDatabaseWriter, type MutationCtx, type QueryCtx, type SyscallChannel, type RegisteredFunction } from "@stackbase/executor";
import type { NotificationsConfig, DigestItem } from "./config";
import { digestWindowMs } from "./config";
import type { EmailContent } from "./provider";
import { recordSend } from "./modules";
import { resolvePreference, isCritical } from "./preferences";
import { compact } from "./render";

/** The built-in digest renderer used when a digest category configures no `digestTemplate`: a plain
 *  concatenation of the buffered items. */
export function defaultDigestTemplate(items: DigestItem[]): EmailContent {
  const subject = `You have ${items.length} update${items.length === 1 ? "" : "s"}`;
  const text = items.map((i) => `• ${i.subject}\n${i.text}`).join("\n\n");
  return { subject, text };
}

const FLUSH_BATCH = 200; // bounded scan of unflushed buffer rows per pass

/**
 * `_flushDue` is driver-invoked (`ctx.runFunction`), which ALWAYS runs PRIVILEGED — a raw table name
 * is used AS-IS, with no namespace auto-prefix (`packages/executor/src/kernel.ts`'s `requireTable`;
 * the exact reason every other driver-facing module in `modules.ts`, e.g. `_reclaimStuck`, writes
 * fully-qualified `"notifications/messages"` literals instead of bare names). `recordSend` and
 * `resolvePreference` (this package) are written to run NAMESPACED — their internal calls use BARE
 * table names (`"messages"`, `"sendReceipts"`, `"notificationPreferences"`, …) that only resolve
 * correctly under namespace auto-prefixing; called with a privileged `db` as-is, those bare names
 * 404 ("unknown index/table"). To reuse them UNMODIFIED from this privileged context (the single-
 * chokepoint rule — don't reimplement the send/preference logic here), `namespacedDb` wraps `ctx.db`
 * in a thin writer that manually prefixes every bare table-name argument with `"notifications/"`
 * before delegating to the SAME underlying syscall channel: a privileged run resolves whatever table
 * name string it's given AS-IS, so a manually-fully-qualified name resolves identically to what
 * namespace auto-prefixing would have produced from a non-privileged caller.
 */
class NamespacedWriter extends GuestDatabaseWriter {
  constructor(channel: SyscallChannel, private readonly prefix: string) {
    super(channel);
  }
  // HARDENING NOTE: `query` + `insert` are the ONLY name-taking writer methods — `get`/`replace`/
  // `delete` take a document id whose table number is embedded in the id itself, so they need no
  // table-name resolution (and no override). `recordSend`/`resolvePreference` touch only `query` +
  // `insert`, so this wrapper re-namespaces everything they hit. If a future edit adds another
  // name-taking call to those functions, add its override here or it will 404 on the privileged path.
  override query(table: string, index: string) {
    return super.query(`${this.prefix}/${table}`, index);
  }
  override insert(table: string, value: Parameters<GuestDatabaseWriter["insert"]>[1]) {
    return super.insert(`${this.prefix}/${table}`, value);
  }
}

function namespacedDb(db: GuestDatabaseWriter, prefix: string): GuestDatabaseWriter {
  const channel = (db as unknown as { channel: SyscallChannel }).channel;
  return new NamespacedWriter(channel, prefix);
}

/** A `(recipientKey, category)` group that is DUE for a flush (returned by `_peekDueGroups`). */
export interface DueGroup { recipientKey: string; category: string }

/**
 * The digest flush is split into TWO driver-invoked functions so each recipient's flush runs in its
 * OWN transaction — a POISON group (e.g. an app `digestTemplate` that throws for one recipient's item
 * shape) can then ONLY fail its own group, caught+logged by the driver's per-group loop, and can
 * NEVER abort the whole pass and wedge delivery of every other notification (including critical auth
 * OTPs) on the node. (An in-mutation `try/catch` would be insufficient: it can't partially roll back,
 * so a caught post-claim throw would leave that group's items claimed-but-undelivered — a silent
 * drop. Per-transaction isolation is the correct shape.)
 *
 * `_peekDueGroups` (query): bounded scan of un-flushed `digestBuffer` rows → the distinct
 * `(recipientKey, category)` groups whose OLDEST item is past the category's rolling window.
 * `_flushGroup` (mutation): flushes ONE group in one txn — fetch ALL its un-flushed items (via
 * `byRecipientCategory`, so a group is never split across the peek batch), CLAIM them (`flushedAt`,
 * same txn — crash-safe, no double-flush), render a combined email via the category's `digestTemplate`
 * (or the default), and send ONE email via `recordSend`.
 *
 * Preference-gate note: `recordSend`'s digest-buffer branch and its preference gate are BOTH keyed off
 * `!isCritical` / `args.critical !== true`, so calling `recordSend` plainly with the same digest
 * category would RE-BUFFER the flushed email (a loop, not a send). So `_flushGroup` resolves the
 * `(userId, category, "email")` preference itself first — reusing `resolvePreference`, the SAME
 * primitive `recordSend`'s gate uses — then calls `recordSend` with `critical: true` so its own
 * (now-redundant) gate+digest-branch is bypassed. Preferences are thus still re-checked at flush.
 *
 * Optional-index-field scan note: `digestBuffer.flushedAt` is `v.optional`, and `.eq(field, value)`
 * serializes `value` via `convexToJson`, which THROWS on `undefined` — so `.eq("flushedAt", undefined)`
 * is unusable. `_peekDueGroups` instead scans `byUnflushed` with no range (bounded by `FLUSH_BATCH`)
 * and filters `flushedAt == null` in memory, mirroring `_peekQueued`'s optional-field filter; the
 * index-key codec orders `null < number`, so un-flushed rows surface first in the bounded batch.
 */
export function makeDigestModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  const _peekDueGroups = query(async (ctx: QueryCtx, args: { now: number }): Promise<DueGroup[]> => {
    const scanned = await ctx.db.query("notifications/digestBuffer", "byUnflushed").take(FLUSH_BATCH).collect();
    const groups = new Map<string, { recipientKey: string; category: string; oldest: number }>();
    for (const r of scanned) {
      if (r.flushedAt != null) continue;
      const recipientKey = r.recipientKey as string;
      const category = r.category as string;
      if (digestWindowMs(config, category) === null) continue; // category no longer digests
      const createdAt = r.createdAt as number;
      const key = JSON.stringify([recipientKey, category]); // collision-proof (vs a raw space join)
      const g = groups.get(key);
      if (!g) groups.set(key, { recipientKey, category, oldest: createdAt });
      else if (createdAt < g.oldest) g.oldest = createdAt;
    }
    const due: DueGroup[] = [];
    for (const g of groups.values()) {
      const window = digestWindowMs(config, g.category);
      if (window !== null && args.now - g.oldest >= window) due.push({ recipientKey: g.recipientKey, category: g.category });
    }
    return due;
  });

  const _flushGroup = mutation(async (ctx: MutationCtx, args: { recipientKey: string; category: string; now: number }): Promise<boolean> => {
    const now = args.now;
    const window = digestWindowMs(config, args.category);
    if (window === null) return false;
    // Fetch ALL of THIS group's un-flushed items — a recipient's digest is never split across passes.
    const all = await ctx.db.query("notifications/digestBuffer", "byRecipientCategory").eq("recipientKey", args.recipientKey).eq("category", args.category).collect();
    const items = all.filter((r) => r.flushedAt == null);
    if (items.length === 0) return false;
    const oldest = Math.min(...items.map((i) => i.createdAt as number));
    if (now - oldest < window) return false; // not due (defensive — peeked due, raced to un-due)
    // CLAIM all items in THIS txn before rendering (crash-safe — no double-flush; `replace` is by _id,
    // so the raw privileged ctx.db needs no table-name resolution).
    for (const it of items) await ctx.db.replace(it._id as string, compact({ ...it, flushedAt: now }));
    const digestItems: DigestItem[] = items
      .sort((a, b) => (a.createdAt as number) - (b.createdAt as number))
      .map((i) => compact({ subject: i.subject as string, text: i.text as string, html: i.html as string | undefined, createdAt: i.createdAt as number }) as unknown as DigestItem);
    const render = config.digestTemplates[args.category] ?? defaultDigestTemplate;
    // A THROW from a faulty app `digestTemplate` rolls back this WHOLE txn (the claim above included),
    // so the items stay un-flushed and are retried next pass — never claimed-but-dropped — and the
    // driver's per-group `try/catch` keeps the throw from touching any other group or the delivery loop.
    const content = render(digestItems);
    const userId = items[0]!.userId as string | undefined;
    const email = items[0]!.email as string;
    const nsDb = namespacedDb(ctx.db as GuestDatabaseWriter, "notifications");
    // Preferences re-checked AT FLUSH (mirrors recordSend's own gate): no `userId` / critical category → proceed.
    if (userId !== undefined && !isCritical(config, args.category) && !(await resolvePreference(nsDb, userId, args.category, "email"))) {
      return true; // suppressed at flush — items stay claimed (won't re-flush), no email sent
    }
    await recordSend(nsDb, now, config, {
      to: compact({ userId, email }),
      channels: ["email"],
      template: { email: content },
      category: args.category,
      critical: true, // bypass recordSend's own gate+digest-branch (decided here) — don't re-buffer
      idempotencyKey: `digest:${args.recipientKey}:${args.category}:${oldest}`,
    });
    return true;
  });

  return { _peekDueGroups, _flushGroup };
}
