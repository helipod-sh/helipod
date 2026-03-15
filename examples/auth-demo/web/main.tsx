import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, webSocketTransport, createAuthClient, anyApi, type SessionInfo } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation } from "@stackbase/client/react";

const api = anyApi as {
  auth: {
    signUp: { __path: string };
    signIn: { __path: string };
    signOut: { __path: string };
    signInAnonymously: { __path: string };
    listSessions: { __path: string };
    revokeSession: { __path: string };
    revokeOtherSessions: { __path: string };
  };
  whoami: { get: { __path: string }; myNotes: { __path: string }; add: { __path: string } };
};

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

function AuthDemo() {
  const [session, setSession] = useState<SessionInfo | null>(() => authClient.getSessionInfo());
  const whoami = useQuery<string | null>(api.whoami.get, {});
  const signUpMut = useMutation<SessionInfo>(api.auth.signUp);
  const signInMut = useMutation<SessionInfo>(api.auth.signIn);
  const signInAnonMut = useMutation<SessionInfo>(api.auth.signInAnonymously);
  const signOutMut = useMutation(api.auth.signOut);

  function adopt(result: SessionInfo) {
    authClient.setSession(result);   // persist + setAuth + schedule refresh + sessionId fingerprint
    setSession(result);
  }

  async function handleSignUp(email: string, password: string) {
    adopt(await signUpMut({ email, password, deviceLabel: navigator.userAgent.slice(0, 60) }));
  }

  async function handleSignIn(email: string, password: string) {
    adopt(await signInMut({ email, password, deviceLabel: navigator.userAgent.slice(0, 60) }));
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

      {signedIn ? (
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
          </fieldset>
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
