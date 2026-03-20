// This demo composes `@stackbase/auth` with an `email` block whose provider is `consoleEmail()`
// (see `../stackbase.config.ts`) — a ZERO-CONFIG dev provider that never actually delivers mail.
// Every verification/reset/magic-link code or link is printed to the `stackbase dev` SERVER
// console (the terminal running `bun run dev`), not shown anywhere in this browser UI. Watch that
// terminal, then paste the code/token into the matching field below.
import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi, type SessionInfo } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation, useAction } from "@stackbase/client/react";

const api = anyApi as {
  auth: {
    signUp: { __path: string };
    signIn: { __path: string };
    signOut: { __path: string };
    signInAnonymously: { __path: string };
    listSessions: { __path: string };
    revokeSession: { __path: string };
    revokeOtherSessions: { __path: string };
    requestEmailVerification: { __path: string };
    verifyEmail: { __path: string };
    requestPasswordReset: { __path: string };
    resetPassword: { __path: string };
    requestMagicLink: { __path: string };
    signInWithMagicLink: { __path: string };
    requestOtp: { __path: string };
    signInWithOtp: { __path: string };
  };
  whoami: { get: { __path: string }; myNotes: { __path: string }; add: { __path: string } };
};

/** `signUp`/`signIn`'s gated return shape (component `SignInResult`, narrowed to the two outcomes
 *  the client ever actually sees — a thrown error covers the `commitThenThrow` case). */
type SignInOutcome = SessionInfo | { needsVerification: true };

function isNeedsVerification(v: unknown): v is { needsVerification: true } {
  return !!v && typeof v === "object" && (v as { needsVerification?: unknown }).needsVerification === true;
}

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const client = new StackbaseClient(webSocketTransport(`${wsProtocol}://${location.host}/api/sync`));

// A1: the token-lifecycle manager — persists the mint result, applies the access token, schedules
// refresh at ~80% of the access TTL, single-refreshes across tabs, and clears on terminal errors.
const authClient = createAuthClient(client, { onSignedOut: () => location.reload() });

type SessionSummary = { sessionId: string; deviceLabel: string | null; createdAt: number | null; lastRefreshAt: number | null; current: boolean };

function AuthForm({ label, onSubmit }: { label: string; onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Email</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
      <label>Password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={6} />
      <div className="btn-row">
        <button type="submit" disabled={busy}>{busy ? "…" : label}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function DevicesPanel() {
  const sessions = useQuery<SessionSummary[]>(api.auth.listSessions, {});
  const revoke = useMutation(api.auth.revokeSession);
  const revokeOthers = useMutation(api.auth.revokeOtherSessions);
  if (!sessions || sessions.length === 0) return null;
  return (
    <fieldset>
      <legend>Your devices</legend>
      <ul className="devices">
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <span>
              {s.deviceLabel ?? "unknown device"} {s.current ? "(this device)" : ""}
              {s.lastRefreshAt ? ` — active ${new Date(s.lastRefreshAt).toLocaleString()}` : ""}
            </span>
            {!s.current && (
              <button className="danger" onClick={() => void revoke({ sessionId: s.sessionId })}>Revoke</button>
            )}
          </li>
        ))}
      </ul>
      <div className="btn-row">
        <button className="danger" onClick={() => void revokeOthers({})}>Sign out everywhere else</button>
      </div>
    </fieldset>
  );
}

function NotesPanel() {
  const notes = useQuery<Array<{ _id: string; body: string }>>(api.whoami.myNotes, {});
  const add = useMutation(api.whoami.add);
  const [body, setBody] = useState("");
  return (
    <fieldset>
      <legend>Your notes (survive an anonymous upgrade)</legend>
      <ul>{(notes ?? []).map((n) => <li key={n._id}>{n.body}</li>)}</ul>
      <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) { void add({ body: body.trim() }); setBody(""); } }}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="write a note…" />
        <button type="submit">Add</button>
      </form>
    </fieldset>
  );
}

/** Shown when a gated `signUp`/`signIn` returns `{ needsVerification: true }` (Task 4's
 *  `requireEmailVerification` gate). "Resend" calls the `requestEmailVerification` action; the code
 *  field redeems via `verifyEmail`, which mints exactly like a normal sign-in. */
function VerifyBanner({ email, onVerified }: { email: string; onVerified: (result: SessionInfo) => void }) {
  const resend = useAction(api.auth.requestEmailVerification);
  const verifyEmailMut = useMutation<SessionInfo>(api.auth.verifyEmail);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  async function handleResend() {
    setError(null);
    setBusy(true);
    try {
      await resend({ email });
      setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onVerified(await verifyEmailMut({ email, code: code.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset>
      <legend>Verify your email</legend>
      <p>
        A verification code was sent to <strong>{email}</strong> — codes print to the{" "}
        <code>stackbase dev</code> server console (the zero-config console provider), never here.
      </p>
      <form onSubmit={handleVerify}>
        <label>Verification code</label>
        <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste the code" required />
        <div className="btn-row">
          <button type="submit" disabled={busy}>{busy ? "…" : "Verify"}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void handleResend()}>
            {resent ? "Resent" : "Resend verification"}
          </button>
        </div>
      </form>
      {error && <div className="error">{error}</div>}
    </fieldset>
  );
}

/** `requestPasswordReset` → a reset-code field → `resetPassword` (mints a fresh session — a reset
 *  revokes every OTHER session on that account too, see `functions.ts#resetPassword`). */
function ForgotPasswordPanel({ onReset }: { onReset: (result: SessionInfo) => void }) {
  const requestReset = useAction(api.auth.requestPasswordReset);
  const resetPasswordMut = useMutation<SessionInfo>(api.auth.resetPassword);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRequest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await requestReset({ email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onReset(await resetPasswordMut({ email: email.trim(), code: code.trim(), newPassword }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset>
      <legend>Forgot password?</legend>
      {!sent ? (
        <form onSubmit={handleRequest}>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          <div className="btn-row">
            <button type="submit" disabled={busy}>{busy ? "…" : "Send reset code"}</button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleReset}>
          <p>
            A reset code for <strong>{email}</strong> printed to the <code>stackbase dev</code> console.
          </p>
          <label>Reset code</label>
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste the code" required />
          <label>New password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} />
          <div className="btn-row">
            <button type="submit" disabled={busy}>{busy ? "…" : "Reset password"}</button>
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </fieldset>
  );
}

/** Passwordless sign-in: `requestMagicLink`/`requestOtp` (actions) → paste-code field →
 *  `signInWithMagicLink`/`signInWithOtp` (mutations, mint exactly like `signIn`). Both flows share
 *  one email field and one paste-code field — only the request/redeem pair differs. */
function PasswordlessPanel({ onSignedIn }: { onSignedIn: (result: SessionInfo) => void }) {
  const requestMagicLink = useAction(api.auth.requestMagicLink);
  const requestOtp = useAction(api.auth.requestOtp);
  const signInWithMagicLinkMut = useMutation<SessionInfo>(api.auth.signInWithMagicLink);
  const signInWithOtpMut = useMutation<SessionInfo>(api.auth.signInWithOtp);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<"magic" | "otp" | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(flow: "magic" | "otp") {
    setError(null);
    setBusy(true);
    try {
      if (flow === "magic") await requestMagicLink({ email: email.trim() });
      else await requestOtp({ email: email.trim() });
      setSent(flow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function redeem(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = sent === "magic"
        ? await signInWithMagicLinkMut({ email: email.trim(), token: code.trim() })
        : await signInWithOtpMut({ email: email.trim(), code: code.trim() });
      onSignedIn(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset>
      <legend>Sign in without a password</legend>
      {!sent ? (
        <>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          <div className="btn-row">
            <button type="button" disabled={busy || !email.trim()} onClick={() => void send("magic")}>Email me a link</button>
            <button type="button" className="secondary" disabled={busy || !email.trim()} onClick={() => void send("otp")}>Email me a code</button>
          </div>
        </>
      ) : (
        <form onSubmit={redeem}>
          <p>
            {sent === "magic" ? "A magic-link token" : "An OTP code"} for <strong>{email}</strong> printed
            to the <code>stackbase dev</code> console.
          </p>
          <label>{sent === "magic" ? "Token" : "Code"}</label>
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste it here" required />
          <div className="btn-row">
            <button type="submit" disabled={busy}>{busy ? "…" : "Sign in"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setSent(null); setCode(""); }}>Back</button>
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </fieldset>
  );
}

function AuthDemo() {
  const [session, setSession] = useState<SessionInfo | null>(() => authClient.getSessionInfo());
  // Set when signUp/signIn comes back gated (`{ needsVerification: true }` — only possible if a
  // deployment turns on `requireEmailVerification`; this demo's default config leaves it off, so
  // this banner is reachable code but won't trigger with the config as shipped in this example).
  const [pendingVerifyEmail, setPendingVerifyEmail] = useState<string | null>(null);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const whoami = useQuery<string | null>(api.whoami.get, {});
  const signUpMut = useMutation<SignInOutcome>(api.auth.signUp);
  const signInMut = useMutation<SignInOutcome>(api.auth.signIn);
  const signInAnonMut = useMutation<SessionInfo>(api.auth.signInAnonymously);
  const signOutMut = useMutation(api.auth.signOut);

  function adopt(result: SessionInfo) {
    authClient.setSession(result);   // persist + setAuth + schedule refresh + sessionId fingerprint
    setSession(result);
    setPendingVerifyEmail(null);
    setShowForgotPassword(false);
  }

  async function handleSignUp(email: string, password: string) {
    const result = await signUpMut({ email, password, deviceLabel: navigator.userAgent.slice(0, 60) });
    if (isNeedsVerification(result)) setPendingVerifyEmail(email);
    else adopt(result);
  }

  async function handleSignIn(email: string, password: string) {
    const result = await signInMut({ email, password, deviceLabel: navigator.userAgent.slice(0, 60) });
    if (isNeedsVerification(result)) setPendingVerifyEmail(email);
    else adopt(result);
  }

  async function handleTryAnonymously() {
    adopt(await signInAnonMut({ deviceLabel: navigator.userAgent.slice(0, 60) }));
  }

  async function handleSignOut() {
    const info = authClient.getSessionInfo();
    if (info) await signOutMut({ token: info.token });   // delete the session row server-side
    authClient.clearSession();                            // clear storage + setAuth(null) + onSignedOut
    setSession(null);
  }

  const signedIn = session !== null;

  return (
    <div className="app">
      <h1>🔐 Stackbase Auth Demo</h1>

      <div className="status-box">
        <div className="label">Reactive identity (whoami.get)</div>
        {whoami === undefined ? (
          <div className="value empty">connecting…</div>
        ) : whoami ? (
          <div className="value">{whoami}</div>
        ) : (
          <div className="value empty">— not signed in —</div>
        )}
      </div>

      {pendingVerifyEmail ? (
        <VerifyBanner email={pendingVerifyEmail} onVerified={adopt} />
      ) : signedIn ? (
        <>
          <NotesPanel />
          <DevicesPanel />
          <fieldset>
            <legend>Upgrade this anonymous account</legend>
            <p>Signing up while anonymous keeps your userId — your notes survive.</p>
            <AuthForm label="Attach email + password" onSubmit={handleSignUp} />
          </fieldset>
          <div className="btn-row" style={{ marginBottom: "1.5rem" }}>
            <button className="danger" onClick={handleSignOut}>Sign out</button>
          </div>
        </>
      ) : (
        <>
          <div className="btn-row">
            <button onClick={handleTryAnonymously}>Try anonymously</button>
          </div>
          <fieldset>
            <legend>Sign up</legend>
            <AuthForm label="Create account" onSubmit={handleSignUp} />
          </fieldset>
          <fieldset>
            <legend>Sign in</legend>
            <AuthForm label="Sign in" onSubmit={handleSignIn} />
            <div className="btn-row">
              <button type="button" className="secondary" onClick={() => setShowForgotPassword((v) => !v)}>
                {showForgotPassword ? "Hide forgot-password" : "Forgot password?"}
              </button>
            </div>
          </fieldset>
          {showForgotPassword && <ForgotPasswordPanel onReset={adopt} />}
          <PasswordlessPanel onSignedIn={adopt} />
        </>
      )}

      <footer>
        Open in two tabs — revoke a device (or sign out) in one tab and the identity clears
        everywhere, reactively. Tokens rotate automatically in the background.
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StackbaseProvider client={client}>
        <AuthDemo />
      </StackbaseProvider>
    </StrictMode>,
  );
}
