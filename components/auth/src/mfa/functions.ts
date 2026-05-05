import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@stackbase/executor";
import type { AuthConfig } from "../config";
import { sha256base64url } from "../crypto";
import { generateTotpSecret, verifyTotp, buildOtpauthUri } from "./totp";
import { encryptSecret, decryptSecret } from "./secret-crypto";
import { generateRecoveryCodes } from "./recovery";
import { MfaNotConfiguredError, MfaAlreadyEnrolledError, MfaNotEnrolledError } from "../errors";

/** Generic, used for every second-factor / enrollment-confirm failure (wrong/expired/consumed/
 *  replayed — never distinguished, spec "Typed error codes"). */
const INVALID = "invalid code";

/** Drop keys whose value is `undefined` — same shape as `functions.ts`'s own `compact` (the
 *  syscall codec rejects `undefined`; omit rather than null it out). Duplicated per-file by this
 *  codebase's existing convention (see `functions.ts`'s comment pointing at
 *  `components/scheduler/src/facade.ts`'s twin). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** The `ctx.auth` facade as visible from inside auth's own modules (every A4 function requires an
 *  authenticated caller) — same structural-cast idiom `functions.ts`'s `currentSessionOf` uses. */
type FacadeCtx = { auth?: { getUserId(): Promise<string | null> } };

async function requireUserId(ctx: MutationCtx | QueryCtx): Promise<string> {
  const userId = await (ctx as unknown as FacadeCtx).auth?.getUserId();
  if (!userId) throw new Error("not authenticated");
  return userId;
}

/** The one enrollment row for a user (one TOTP factor per user in v1 — spec "Schema"), confirmed
 *  or not. `null` when the user has never started enrollment. */
async function enrollmentFor(ctx: MutationCtx | QueryCtx, userId: string): Promise<Record<string, unknown> | null> {
  const [row] = await ctx.db.query("mfaEnrollments", "byUserId").eq("userId", userId).collect();
  return (row as Record<string, unknown> | undefined) ?? null;
}

/**
 * Verify a presented code as a live TOTP against ONE enrollment row (decrypt -> `verifyTotp` ->
 * replay-guard -> advance `lastUsedStep` on success, spec decision 9). Returns `false` (never
 * throws) for a wrong/replayed code, an unconfirmed enrollment, or a decrypt failure (a tampered/
 * corrupt envelope is treated as a non-match, not a crash — the caller falls through to its own
 * generic-invalid handling). Shared by `confirmMfaEnrollment` (which has no `lastUsedStep` guard
 * yet — the very first accepted step is the first commit), `regenerateRecoveryCodes` (TOTP-ONLY
 * re-auth, spec decision 11 — a recovery code must not be usable to mint fresh recovery codes),
 * and `verifyUserSecondFactor`'s TOTP arm.
 */
async function verifyTotpForEnrollment(
  ctx: MutationCtx,
  config: AuthConfig,
  enrollment: Record<string, unknown>,
  userId: string,
  code: string,
): Promise<number | null> {
  if (enrollment.confirmedAt === undefined) return null; // inert (decision 4) — never gates/re-auths
  const mfa = config.mfa!;
  try {
    const secret = decryptSecret(mfa.keyring, enrollment.secretEncrypted as string, userId);
    const lastUsedStep = (enrollment.lastUsedStep as number | undefined) ?? -1;
    const matchedStep = verifyTotp(secret, code, ctx.now(), {
      algorithm: mfa.algorithm,
      digits: mfa.digits,
      period: mfa.period,
      window: mfa.window,
    });
    if (matchedStep !== null && matchedStep > lastUsedStep) return matchedStep;
    return null;
  } catch {
    return null; // tampered/corrupt envelope, unknown keyId, etc. — never a crash, just a non-match
  }
}

/**
 * Verify a user's second factor: try a live TOTP first (advancing `lastUsedStep` on success, the
 * replay guard — spec decision 9), then a recovery code (hash-lookup + consume-by-delete, spec
 * decisions 7/8). Returns which factor matched, or `null` if neither did. Exported for Task 5's
 * `completeMfaSignIn` to reuse verbatim (spec "Interfaces").
 */
export async function verifyUserSecondFactor(
  ctx: MutationCtx,
  config: AuthConfig,
  userId: string,
  code: string,
): Promise<"totp" | "recovery" | null> {
  if (!config.mfa) return null;
  const enrollment = await enrollmentFor(ctx, userId);
  if (enrollment) {
    const matchedStep = await verifyTotpForEnrollment(ctx, config, enrollment, userId, code);
    if (matchedStep !== null) {
      await ctx.db.replace(enrollment._id as string, { ...enrollment, lastUsedStep: matchedStep });
      return "totp";
    }
  }
  const codeHash = sha256base64url(code);
  const [recRow] = await ctx.db
    .query("mfaRecoveryCodes", "byUserCode")
    .eq("userId", userId)
    .eq("codeHash", codeHash)
    .collect();
  if (recRow) {
    await ctx.db.delete(recRow._id as string); // consume-once (spec decision 7)
    return "recovery";
  }
  return null;
}

/**
 * Build the A4 (MFA/TOTP) module set closing over `config` (spec "Component surface"). Every
 * function here requires an authenticated caller (`ctx.auth.getUserId()`); the second-factor GATE
 * itself (`finishSignIn`/`completeMfaSignIn`) is Task 5 — this task is only the enrolled-user
 * management surface + the shared `verifyUserSecondFactor` helper Task 5 reuses.
 */
export function makeMfaModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const startMfaEnrollment = mutation(async (ctx: MutationCtx) => {
    if (!config.mfa) throw new MfaNotConfiguredError();
    const mfa = config.mfa;
    const userId = await requireUserId(ctx);

    const existing = await enrollmentFor(ctx, userId);
    if (existing && existing.confirmedAt !== undefined) throw new MfaAlreadyEnrolledError(); // must disableMfa first
    if (existing) await ctx.db.delete(existing._id as string); // overwrite a prior UNCONFIRMED row (decision 4)

    const secret = generateTotpSecret(); // CSPRNG inside the mutation (A1/A2 precedent)
    const user = await ctx.db.get(userId);
    const accountName = (user?.email as string | undefined) ?? userId;
    const otpauthUri = buildOtpauthUri({
      issuer: mfa.issuer,
      accountName,
      secretBase32: secret,
      algorithm: mfa.algorithm,
      digits: mfa.digits,
      period: mfa.period,
    });
    const secretEncrypted = encryptSecret(mfa.keyring, secret, userId); // AAD=userId (decision 3)

    await ctx.db.insert(
      "mfaEnrollments",
      compact({
        userId,
        secretEncrypted,
        algorithm: mfa.algorithm,
        digits: mfa.digits,
        period: mfa.period,
        confirmedAt: undefined, // inert until confirmMfaEnrollment proves a live code
        lastUsedStep: undefined,
        createdAt: ctx.now(),
      }),
    );

    // Raw secret + URI returned ONCE from inside the mutation — the mint precedent. Never stored
    // in the clear (secretEncrypted above is the only persisted form).
    return { secret, otpauthUri, digits: mfa.digits, period: mfa.period, algorithm: mfa.algorithm };
  });

  const confirmMfaEnrollment = mutation(async (ctx: MutationCtx, { code }: { code: string }) => {
    if (!config.mfa) throw new MfaNotConfiguredError();
    const mfa = config.mfa;
    const userId = await requireUserId(ctx);

    const enrollment = await enrollmentFor(ctx, userId);
    if (!enrollment || enrollment.confirmedAt !== undefined) throw new MfaNotEnrolledError();

    let matchedStep: number | null;
    try {
      const secret = decryptSecret(mfa.keyring, enrollment.secretEncrypted as string, userId);
      matchedStep = verifyTotp(secret, code, ctx.now(), {
        algorithm: mfa.algorithm,
        digits: mfa.digits,
        period: mfa.period,
        window: mfa.window,
      });
    } catch {
      matchedStep = null;
    }
    if (matchedStep === null) throw new Error(INVALID); // wrong confirm code — enrollment stays unconfirmed

    await ctx.db.replace(enrollment._id as string, { ...enrollment, confirmedAt: ctx.now(), lastUsedStep: matchedStep });

    // Only NOW generate the recovery-code set (decision 4/7) — a failed confirm never mints codes.
    const rawCodes = generateRecoveryCodes(mfa.recoveryCodeCount);
    for (const raw of rawCodes) {
      await ctx.db.insert("mfaRecoveryCodes", { userId, codeHash: sha256base64url(raw), createdAt: ctx.now() });
    }
    return { recoveryCodes: rawCodes }; // raw codes returned ONCE
  });

  const disableMfa = mutation(async (ctx: MutationCtx, { code }: { code: string }) => {
    if (!config.mfa) throw new MfaNotConfiguredError();
    const userId = await requireUserId(ctx);

    const enrollment = await enrollmentFor(ctx, userId);
    if (!enrollment || enrollment.confirmedAt === undefined) throw new MfaNotEnrolledError();

    const factor = await verifyUserSecondFactor(ctx, config, userId, code); // TOTP OR recovery (decision 11)
    if (!factor) throw new Error(INVALID);

    await ctx.db.delete(enrollment._id as string);
    const rows = await ctx.db.query("mfaRecoveryCodes", "byUserId").eq("userId", userId).collect();
    for (const r of rows) await ctx.db.delete(r._id as string); // whole recovery set goes with it
    return null;
  });

  const regenerateRecoveryCodes = mutation(async (ctx: MutationCtx, { code }: { code: string }) => {
    if (!config.mfa) throw new MfaNotConfiguredError();
    const mfa = config.mfa;
    const userId = await requireUserId(ctx);

    const enrollment = await enrollmentFor(ctx, userId);
    if (!enrollment || enrollment.confirmedAt === undefined) throw new MfaNotEnrolledError();

    // TOTP-ONLY re-auth (spec decision 11) — a recovery code must not be usable to mint a fresh
    // recovery-code set (self-referential; it would also burn one of the codes being replaced).
    const matchedStep = await verifyTotpForEnrollment(ctx, config, enrollment, userId, code);
    if (matchedStep === null) throw new Error(INVALID);
    await ctx.db.replace(enrollment._id as string, { ...enrollment, lastUsedStep: matchedStep });

    const rows = await ctx.db.query("mfaRecoveryCodes", "byUserId").eq("userId", userId).collect();
    for (const r of rows) await ctx.db.delete(r._id as string); // replace the WHOLE set
    const rawCodes = generateRecoveryCodes(mfa.recoveryCodeCount);
    for (const raw of rawCodes) {
      await ctx.db.insert("mfaRecoveryCodes", { userId, codeHash: sha256base64url(raw), createdAt: ctx.now() });
    }
    return { recoveryCodes: rawCodes };
  });

  const getMfaStatus = query(async (ctx: QueryCtx) => {
    if (!config.mfa) throw new MfaNotConfiguredError();
    const userId = await requireUserId(ctx);

    const enrollment = await enrollmentFor(ctx, userId);
    const enrolled = !!enrollment;
    const confirmed = !!enrollment && enrollment.confirmedAt !== undefined;
    let recoveryCodesRemaining = 0;
    if (confirmed) {
      // `byUserId` range, never a table scan — reactive: a recovery-code consume/regenerate
      // re-runs a subscribed getMfaStatus.
      recoveryCodesRemaining = (await ctx.db.query("mfaRecoveryCodes", "byUserId").eq("userId", userId).collect()).length;
    }
    return { enrolled, confirmed, recoveryCodesRemaining };
  });

  return { startMfaEnrollment, confirmMfaEnrollment, disableMfa, regenerateRecoveryCodes, getMfaStatus };
}
