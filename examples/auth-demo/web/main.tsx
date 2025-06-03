import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation } from "@stackbase/client/react";

const api = anyApi as {
  auth: {
    signUp: { __path: string };
    signIn: { __path: string };
    signOut: { __path: string };
  };
  whoami: { get: { __path: string } };
};

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const client = new StackbaseClient(webSocketTransport(`${wsProtocol}://${location.host}/api/sync`));

type AuthResult = { token: string; userId: string };

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

function AuthDemo() {
  const [token, setToken] = useState<string | null>(null);
  const whoami = useQuery<string | null>(api.whoami.get, {});
  const signUpMut = useMutation<AuthResult>(api.auth.signUp);
  const signInMut = useMutation<AuthResult>(api.auth.signIn);
  const signOutMut = useMutation(api.auth.signOut);

  async function handleSignUp(email: string, password: string) {
    const result = await signUpMut({ email, password });
    client.setAuth(result.token);
    setToken(result.token);
  }

  async function handleSignIn(email: string, password: string) {
    const result = await signInMut({ email, password });
    client.setAuth(result.token);
    setToken(result.token);
  }

  async function handleSignOut() {
    if (!token) return;
    await signOutMut({ token });
    client.setAuth(null);
    setToken(null);
  }

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

      {token ? (
        <div className="btn-row" style={{ marginBottom: "1.5rem" }}>
          <button className="danger" onClick={handleSignOut}>Sign out</button>
        </div>
      ) : (
        <>
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
        Open in two tabs — sign out in one tab and the identity clears everywhere, reactively.
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
