import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, type QueryCtx } from "@stackbase/executor";
import { defineAuth } from "../src/component";
import type { AuthOptions, EmailMessage, EmailProvider, MintResult, NeedsVerification } from "../src";

/** A capture provider (per the Task 2 brief, reused here): records every send, never delivers
 *  anything. Tests extract the raw code/token from `sent[i].text`. */
function captureProvider(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { async send(m) { sent.push(m); } } };
}

function extractToken(text: string): string {
  const m = text.match(/token=([^&\s]+)/);
  if (!m) throw new Error(`no token found in email text: ${text}`);
  return m[1]!;
}

// Privileged test-only read, same idiom as email-redeem.test.ts's `_readUser`.
const _readUser = query(async (ctx: QueryCtx, { email }: { email: string }) => {
  const [row] = await ctx.db.query("auth/users", "byEmail").eq("email", email).collect();
  return row ?? null;
});

async function makeRuntime(authOpts?: AuthOptions, now?: () => number) {
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
    systemModules: { "_test:readUser": _readUser },
    ...(now ? { now } : {}),
  });
}

async function readUser(r: EmbeddedRuntime, email: string): Promise<Record<string, unknown> | null> {
  return (await r.runSystem<Record<string, unknown> | null>("_test:readUser", { email })).value;
}

async function issueVerifyToken(r: EmbeddedRuntime, sent: EmailMessage[], email: string): Promise<string> {
  await r.run("auth:requestEmailVerification", { email });
  return extractToken(sent[sent.length - 1]!.text);
}

describe("auth A2: requireEmailVerification gate on signUp/signIn (Task 4)", () => {
  it("gate off (default): signUp/signIn are byte-identical to A1 — a full mint result, no needsVerification key", async () => {
    const r = await makeRuntime(); // no email config at all — A1 surface
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect(typeof up.token).toBe("string");
    expect(typeof up.refreshToken).toBe("string");
    expect(typeof up.sessionId).toBe("string");
    expect(typeof up.userId).toBe("string");
    expect(typeof up.expiresAt).toBe("number");
    expect("needsVerification" in up).toBe(false);

    const inRes = (await r.run<MintResult>("auth:signIn", { email: "a@b.co", password: "pw" })).value;
    expect(typeof inRes.token).toBe("string");
    expect("needsVerification" in inRes).toBe(false);
  });

  it("gate configured but explicitly false: still byte-identical mint (email configured, requireEmailVerification: false)", async () => {
    const { provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com", requireEmailVerification: false } });
    const up = (await r.run<MintResult>("auth:signUp", { email: "b@b.co", password: "pw" })).value;
    expect(typeof up.token).toBe("string");
    expect("needsVerification" in up).toBe(false);
    const inRes = (await r.run<MintResult>("auth:signIn", { email: "b@b.co", password: "pw" })).value;
    expect(typeof inRes.token).toBe("string");
    expect("needsVerification" in inRes).toBe(false);
  });

  it("gate on: unverified signUp returns needsVerification with NO tokens; requestEmailVerification + verifyEmail then mints; a subsequent signIn (now verified) mints directly (attribution: convex-auth passwords.test.ts:68-113)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com", requireEmailVerification: true } }, () => nowMs);

    const signUpResult = (await r.run<MintResult | NeedsVerification>("auth:signUp", { email: "gate@x.co", password: "pw" })).value;
    expect(signUpResult).toEqual({ needsVerification: true });
    expect(sent.length).toBe(0); // signUp itself does NO I/O — no send happened as a side effect

    // signIn of the same still-unverified account also gates.
    const signInResult = (await r.run<MintResult | NeedsVerification>("auth:signIn", { email: "gate@x.co", password: "pw" })).value;
    expect(signInResult).toEqual({ needsVerification: true });

    // The client drives the resend itself.
    const token = await issueVerifyToken(r, sent, "gate@x.co");
    const verified = (await r.run<MintResult>("auth:verifyEmail", { email: "gate@x.co", code: token })).value;
    expect(typeof verified.token).toBe("string");
    expect(await readUser(r, "gate@x.co")).toMatchObject({ emailVerified: true });

    // A subsequent signIn (now verified) mints directly — no more gating.
    const signedInAgain = (await r.run<MintResult | NeedsVerification>("auth:signIn", { email: "gate@x.co", password: "pw" })).value;
    expect(typeof (signedInAgain as MintResult).token).toBe("string");
    expect("needsVerification" in (signedInAgain as object)).toBe(false);
  });

  it("gate on: signIn of an unverified existing account returns needsVerification, no token", async () => {
    let nowMs = 1_000_000_000_000;
    const { provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com", requireEmailVerification: true } }, () => nowMs);
    await r.run("auth:signUp", { email: "existing@x.co", password: "pw" }); // needsVerification; unverified account now exists
    const result = (await r.run<MintResult | NeedsVerification>("auth:signIn", { email: "existing@x.co", password: "pw" })).value;
    expect(result).toEqual({ needsVerification: true });
  });

  it("already-verified account signing in under the gate mints normally (the gate only blocks unverified accounts)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com", requireEmailVerification: true } }, () => nowMs);

    await r.run("auth:signUp", { email: "verified@x.co", password: "pw" }); // needsVerification
    const token = await issueVerifyToken(r, sent, "verified@x.co");
    await r.run("auth:verifyEmail", { email: "verified@x.co", code: token }); // flips emailVerified: true

    const signedIn = (await r.run<MintResult | NeedsVerification>("auth:signIn", { email: "verified@x.co", password: "pw" })).value;
    expect(typeof (signedIn as MintResult).token).toBe("string");
    expect("needsVerification" in (signedIn as object)).toBe(false);
  });

  it("anonymous-upgrade composition under the gate: signUp gets needsVerification but the anon session SURVIVES (keeps working) until verifyEmail mints, which then wipes the old anon session (uniform first-proof rule)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com", requireEmailVerification: true } }, () => nowMs);

    // Anonymous sign-in, then write a row while anonymous (proven to survive via userId continuity).
    const anon = (await r.run<MintResult>("auth:signInAnonymously", {})).value;
    expect((await r.run<string | null>("auth:getUserId", { token: anon.token })).value).toBe(anon.userId);

    // Upgrade via signUp while holding the anon session, under the gate.
    const upgradeResult = (await r.run<MintResult | NeedsVerification>(
      "auth:signUp",
      { email: "upgrade@x.co", password: "pw" },
      { identity: anon.token },
    )).value;
    expect(upgradeResult).toEqual({ needsVerification: true }); // no tokens minted

    // The upgrade itself already ran: userId/anonymous flag/email were updated on the SAME row.
    const userAfterUpgrade = await readUser(r, "upgrade@x.co");
    expect(userAfterUpgrade!._id).toBe(anon.userId);
    expect(userAfterUpgrade!.anonymous).toBeUndefined();

    // Critically: the OLD anon session is STILL alive — the gate did NOT wipe it (composition).
    expect((await r.run<string | null>("auth:getUserId", { token: anon.token })).value).toBe(anon.userId);

    // Verify mailbox control: verifyEmail then mints AND wipes the old anon session (deferred wipe,
    // performed by markVerifiedRevokingIfFirstProof at the false→true flip).
    const token = await issueVerifyToken(r, sent, "upgrade@x.co");
    const verified = (await r.run<MintResult>("auth:verifyEmail", { email: "upgrade@x.co", code: token })).value;
    expect(verified.userId).toBe(anon.userId); // same underlying user throughout

    // The old anon token now dies...
    expect((await r.run<string | null>("auth:getUserId", { token: anon.token })).value).toBeNull();
    // ...while the fresh verify-minted session resolves to the SAME userId.
    expect((await r.run<string | null>("auth:getUserId", { token: verified.token })).value).toBe(anon.userId);
  });
});
