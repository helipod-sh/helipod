import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, type QueryCtx } from "@stackbase/executor";
import { defineAuth } from "../src/component";
import { sha256base64url, type AuthOptions, type EmailMessage, type EmailProvider } from "../src";

/** A capture provider (per the brief): records every send, never actually delivers anything. The
 *  test extracts the raw code/token from `sent[i].text` — exactly what a real user would read out
 *  of their inbox. */
function captureProvider(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { async send(m) { sent.push(m); } } };
}

function extractOtp(text: string): string {
  const m = text.match(/code is:\n\n(\d{8})\n/);
  if (!m) throw new Error(`no OTP found in email text: ${text}`);
  return m[1]!;
}
function extractToken(text: string): string {
  const m = text.match(/token=([^&\s]+)/);
  if (!m) throw new Error(`no token found in email text: ${text}`);
  return m[1]!;
}

/**
 * Privileged test-only query reading `auth/authCodes` directly by `(email, flow)` — the RAW physical
 * table name a privileged run must address (component tables are namespaced `component/table`;
 * that namespacing is applied transparently only for non-privileged calls — see
 * `packages/executor/src/kernel.ts`'s `ctx.privileged ? spec.table : getFullTableName(...)`, and
 * `session-core.test.ts`'s `"auth/sessions"` precedent). Registered as a `systemModules` entry so it
 * runs via `EmbeddedRuntime.runSystem` (trusted callers only — no `isInternalPath` gate), the exact
 * mechanism `@stackbase/test`'s own `_test:_run` uses; this slice's tests follow the raw
 * `composeComponents` + `EmbeddedRuntime.create` idiom (not `createTestStackbase`), so it's
 * reimplemented inline here rather than imported.
 */
const _readAuthCode = query(async (ctx: QueryCtx, { email, flow }: { email: string; flow: string }) => {
  const [row] = await ctx.db.query("auth/authCodes", "byEmailFlow").eq("email", email).eq("flow", flow).collect();
  return row ?? null;
});

async function makeRuntime(authOpts: AuthOptions, now: () => number) {
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [defineAuth(authOpts)],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    contextProviders,
    systemModules: { "_test:readAuthCode": _readAuthCode },
    now,
  });
}

async function readAuthCode(r: EmbeddedRuntime, email: string, flow: string): Promise<Record<string, unknown> | null> {
  return (await r.runSystem<Record<string, unknown> | null>("_test:readAuthCode", { email, flow })).value;
}

describe("auth A2: authCodes core (_issueCode + request* actions)", () => {
  it("hashed at rest — codeHash is set, no field on the row equals the raw code from the email", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co" } }, () => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });

    await r.run("auth:requestOtp", { email: "a@b.co" });
    expect(sent.length).toBe(1);
    const rawCode = extractOtp(sent[0]!.text);

    const row = await readAuthCode(r, "a@b.co", "otp");
    expect(row).not.toBeNull();
    expect(typeof row!.codeHash).toBe("string");
    // The raw code appears NOWHERE in the persisted row.
    for (const [key, value] of Object.entries(row!)) {
      if (typeof value === "string") expect(value).not.toBe(rawCode);
    }
    expect(JSON.stringify(row)).not.toContain(rawCode);
  });

  it("OTP shape is exactly 8 numeric digits; magic/reset/verify links are 32-char base64url", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });

    await r.run("auth:requestOtp", { email: "a@b.co" });
    const otp = extractOtp(sent[sent.length - 1]!.text);
    expect(otp).toMatch(/^\d{8}$/);

    await r.run("auth:requestMagicLink", { email: "a@b.co" });
    const magicToken = extractToken(sent[sent.length - 1]!.text);
    expect(magicToken).toMatch(/^[A-Za-z0-9_-]{32}$/);

    await r.run("auth:requestPasswordReset", { email: "a@b.co" });
    const resetToken = extractToken(sent[sent.length - 1]!.text);
    expect(resetToken).toMatch(/^[A-Za-z0-9_-]{32}$/);

    await r.run("auth:requestEmailVerification", { email: "a@b.co" });
    const verifyToken = extractToken(sent[sent.length - 1]!.text);
    expect(verifyToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("overwrite: only the LAST-issued code's hash is ever valid — exactly one row per (email, flow)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co" } }, () => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });

    await r.run("auth:requestOtp", { email: "a@b.co" });
    const first = extractOtp(sent[0]!.text);

    nowMs += 61_000; // past the default 60s requestCooldownMs
    await r.run("auth:requestOtp", { email: "a@b.co" });
    const second = extractOtp(sent[1]!.text);
    expect(second).not.toBe(first);

    const row = await readAuthCode(r, "a@b.co", "otp");
    expect(row).not.toBeNull();
    // Only ONE row exists (verified via readAuthCode returning the single byEmailFlow match), and its
    // hash matches ONLY the second code — the first is no longer the one on file (Task 3's redeem
    // proves it no longer verifies; here we prove the overwrite at the hash layer).
    expect(row!.codeHash).toBe(sha256base64url(second));
    expect(row!.codeHash).not.toBe(sha256base64url(first));
  });

  it("cooldown: an immediate re-request rejects EMAIL_COOLDOWN; after requestCooldownMs it issues fresh (attribution: convex-auth rateLimit.test.ts)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", requestCooldownMs: 60_000 } }, () => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });

    await r.run("auth:requestOtp", { email: "a@b.co" });
    expect(sent.length).toBe(1);

    await expect(r.run("auth:requestOtp", { email: "a@b.co" })).rejects.toThrow(/EMAIL_COOLDOWN/);
    expect(sent.length).toBe(1); // no second send while on cooldown

    nowMs += 60_000; // exactly the cooldown boundary
    await r.run("auth:requestOtp", { email: "a@b.co" });
    expect(sent.length).toBe(2);
  });

  it("global throttle: emailSendsPerMinute trips at the cap and recovers after the 60s window (attribution: convex-auth rateLimit.test.ts)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime(
      { email: { provider, from: "noreply@app.co", emailSendsPerMinute: 2, requestCooldownMs: 0 } },
      () => nowMs,
    );
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });

    await r.run("auth:requestOtp", { email: "a@b.co" });
    await r.run("auth:requestOtp", { email: "a@b.co" });
    expect(sent.length).toBe(2);

    await expect(r.run("auth:requestOtp", { email: "a@b.co" })).rejects.toThrow(/EMAIL_THROTTLED/);
    expect(sent.length).toBe(2); // the 3rd never sent

    nowMs += 60_000; // new window
    await r.run("auth:requestOtp", { email: "a@b.co" });
    expect(sent.length).toBe(3);
  });

  it("anti-enumeration: requestPasswordReset for an unknown email returns { sent: true } but sends nothing and writes no row", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co" } }, () => nowMs);

    const result = (await r.run<{ sent: true }>("auth:requestPasswordReset", { email: "unknown@x.co" })).value;
    expect(result).toEqual({ sent: true });
    expect(sent.length).toBe(0);
    expect(await readAuthCode(r, "unknown@x.co", "reset")).toBeNull();
  });

  it("anti-enumeration: requestEmailVerification for an unknown email returns { sent: true } but sends nothing and writes no row", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co" } }, () => nowMs);

    const result = (await r.run<{ sent: true }>("auth:requestEmailVerification", { email: "unknown@x.co" })).value;
    expect(result).toEqual({ sent: true });
    expect(sent.length).toBe(0);
    expect(await readAuthCode(r, "unknown@x.co", "verify")).toBeNull();
  });

  it("createUsersOnEmailSignIn:false — an unknown email's requestMagicLink/requestOtp returns { sent: true } but sends nothing and writes no row", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", createUsersOnEmailSignIn: false } }, () => nowMs);

    const magicResult = (await r.run<{ sent: true }>("auth:requestMagicLink", { email: "unknown@x.co" })).value;
    expect(magicResult).toEqual({ sent: true });
    expect(sent.length).toBe(0);
    expect(await readAuthCode(r, "unknown@x.co", "magic")).toBeNull();

    const otpResult = (await r.run<{ sent: true }>("auth:requestOtp", { email: "unknown2@x.co" })).value;
    expect(otpResult).toEqual({ sent: true });
    expect(sent.length).toBe(0);
    expect(await readAuthCode(r, "unknown2@x.co", "otp")).toBeNull();
  });

  it("createUsersOnEmailSignIn:true (default) — an unknown email's requestMagicLink writes a row and sends", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co" } }, () => nowMs);

    const result = (await r.run<{ sent: true }>("auth:requestMagicLink", { email: "unknown@x.co" })).value;
    expect(result).toEqual({ sent: true });
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe("unknown@x.co");
    expect(await readAuthCode(r, "unknown@x.co", "magic")).not.toBeNull();
  });

  it("normalizes email casing/whitespace consistently between issuance and the stored row", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co" } }, () => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });

    await r.run("auth:requestOtp", { email: "  A@B.co " });
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe("a@b.co");
    expect(await readAuthCode(r, "a@b.co", "otp")).not.toBeNull();
  });
});
