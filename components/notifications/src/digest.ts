import { mutation, GuestDatabaseWriter, type MutationCtx, type SyscallChannel, type RegisteredFunction } from "@stackbase/executor";
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

/**
 * `_flushDue` — driver-invoked: scan un-flushed `digestBuffer` rows, group by (recipientKey,
 * category), and for a group whose OLDEST item is past the category's rolling window, CLAIM its
 * items (`flushedAt = now`, in THIS txn — the crash-safe claim, before rendering/sending), render a
 * combined email via the category's `digestTemplate` (or the default), and send ONE combined email
 * to the recipient via `recordSend` (bounded per pass).
 *
 * Preference-gate note (why this isn't just a plain `recordSend(..., { category, ... })` call):
 * `recordSend`'s digest-buffer branch and its preference gate are BOTH keyed off the same
 * `!isCritical(config, category)` / `args.critical !== true` pair. Calling it plainly with the SAME
 * digest-configured `category` would hit that SAME digest-buffer branch again — the "flushed" email
 * would just be re-buffered into `digestBuffer` instead of ever being delivered (a re-buffer loop,
 * not a send). So this resolves the (userId, category, "email") preference itself first — reusing
 * `resolvePreference`, the SAME primitive `recordSend`'s own gate uses, not a reimplementation of the
 * policy — and, having already decided that, calls `recordSend` with `critical: true` so its OWN
 * preference+digest-buffer gate (redundant at this point) is bypassed rather than re-triggered.
 * Preferences are thus still "re-checked at flush": a recipient who unsubscribed after buffering is
 * honored here, exactly as if `recordSend`'s own gate had run.
 *
 * Optional-index-field scan note: `digestBuffer.flushedAt` is `v.optional`, and the engine's
 * `.eq(field, value)` range constraint serializes `value` via `convexToJson`, which THROWS on
 * `undefined` (there is no JSON encoding for it) — so `.eq("flushedAt", undefined)` is not usable.
 * Instead this scans the `byUnflushed` index with NO range constraint (a full-index scan bounded by
 * `.take(FLUSH_BATCH)`) and filters `flushedAt == null` in memory, mirroring `_peekQueued`'s
 * in-memory `nextAttemptAt` filter over `byStatus`. This is actually favorable here: the index-key
 * codec orders `null < number` (see `@stackbase/index-key-codec`), so ascending order surfaces every
 * un-flushed row (encoded key `null`) before any already-flushed row — the bounded batch fills with
 * unflushed rows first, not stale flushed ones.
 */
export function makeDigestModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  const _flushDue = mutation(async (ctx: MutationCtx, args: { now: number }): Promise<number> => {
    const now = args.now;
    const scanned = await ctx.db.query("notifications/digestBuffer", "byUnflushed").take(FLUSH_BATCH).collect();
    const rows = scanned.filter((r) => r.flushedAt == null);
    // Group un-flushed rows by recipientKey+category.
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const key = `${r.recipientKey as string} ${r.category as string}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }
    const nsDb = namespacedDb(ctx.db, "notifications");
    let flushed = 0;
    for (const items of groups.values()) {
      const category = items[0]!.category as string;
      const window = digestWindowMs(config, category);
      if (window === null) continue; // category no longer digests — leave buffered (config changed)
      const oldest = Math.min(...items.map((i) => i.createdAt as number));
      if (now - oldest < window) continue; // not due yet
      // CLAIM: mark all items flushed in THIS txn before rendering (crash-safe — no double-flush).
      // `replace` resolves by the doc's own `_id` (its table number is embedded in the id itself), so
      // it needs no table-name resolution at all — the raw privileged `ctx.db` is fine here.
      for (const it of items) await ctx.db.replace(it._id as string, compact({ ...it, flushedAt: now }));
      const digestItems: DigestItem[] = items
        .sort((a, b) => (a.createdAt as number) - (b.createdAt as number))
        .map((i) => compact({ subject: i.subject as string, text: i.text as string, html: i.html as string | undefined, createdAt: i.createdAt as number }) as unknown as DigestItem);
      const render = config.digestTemplates[category] ?? defaultDigestTemplate;
      const content = render(digestItems);
      const userId = items[0]!.userId as string | undefined;
      const email = items[0]!.email as string;
      // Preferences re-checked AT FLUSH (see the module doc comment above): mirrors recordSend's own
      // `resolvePreference` gate. A recipient with no `userId` (no preference identity) or a critical
      // category always proceeds, same as `recordSend`.
      if (userId !== undefined && !isCritical(config, category) && !(await resolvePreference(nsDb, userId, category, "email"))) {
        continue; // suppressed at flush — the claimed items are simply discarded, never delivered
      }
      // Send ONE combined email via the single chokepoint. `critical: true` bypasses recordSend's OWN
      // preference+digest-buffer gate — already decided above — so this doesn't re-buffer into
      // `digestBuffer` for the same digest-configured category. A per-flush idempotency key dedups a
      // driver re-run of the same claimed group.
      await recordSend(nsDb, now, config, {
        to: compact({ userId, email }),
        channels: ["email"],
        template: { email: content },
        category,
        critical: true,
        idempotencyKey: `digest:${items[0]!.recipientKey}:${category}:${oldest}`,
      });
      flushed++;
    }
    return flushed;
  });
  return { _flushDue };
}
