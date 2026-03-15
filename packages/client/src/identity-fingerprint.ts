/**
 * Shared identity-fingerprint primitives for the durable outbox (verdict §(d) hazard 9 / spec
 * §(k)7). `client.ts`'s live `setAuth`/`setSessionFingerprint` and `headless-drain.ts`'s one-shot
 * `drainOutboxOnce` must compute the EXACT SAME `identityFingerprint` for the same underlying
 * identity, or the two never agree — a durable entry stamped by a live tab under a managed
 * session's `sessionFingerprintKey` hash would otherwise look "foreign" to the headless drain's own
 * differently-formatted hash and terminal-fail with `OFFLINE_IDENTITY_CHANGED` even though nothing
 * about the identity actually changed. One shared module, not two hand-synced copies, is how that's
 * kept impossible by construction.
 */

/** SHA-256 hex digest of `input`. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The string a managed `createAuthClient` session's outbox fingerprint hashes (never the raw
 *  `sessionId` alone) — `client.ts#setSessionFingerprint` and `headless-drain.ts`'s `getSessionId`
 *  option both route through this ONE function so the "session:" prefix convention can never drift
 *  between the two call sites (spec decision 9). */
export function sessionFingerprintKey(sessionId: string): string {
  return `session:${sessionId}`;
}
