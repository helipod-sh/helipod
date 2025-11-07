/**
 * Client-mutation dedup classification (the Receipted Outbox, verdict §(c)) — the OWNER-side half of
 * the resend-exactly-once contract. These helpers run WHERE THE COMMIT RUNS (single-node locally, or
 * the owning writer on a fleet forward — verdict §(c) repair 3), never in the sync handler and never
 * against a follower's replica. The sync handler only threads `{clientId, seq}` down and interprets
 * the discriminated replay.
 *
 * Two enforcement layers, per the verdict:
 *  - CLASSIFICATION (the fast path): a pre-read of `getClientVerdict`/`getClientFloor`. It can race a
 *    concurrent duplicate (no lock spans read→commit), so it is an OPTIMISATION, not the barrier.
 *  - The COMMIT GUARD (the barrier): {@link clientReceiptsGuard} INSERTs the `applied` receipt inside
 *    the mutation's own commit transaction — a PK collision is the dedup signal, thrown as a typed
 *    {@link CommitGuardRejection} whose loser re-reads the winner's row and replay-acks.
 */
import {
  CommitGuardRejection,
  isRetryableError,
  isStackbaseError,
} from "@stackbase/errors";
import type { ShardId } from "@stackbase/id-codec";
import type { ClientReplay } from "@stackbase/executor";
import type { ClientMutationVerdict } from "@stackbase/sync";
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import type { CommitGuardUnit, DocStore, ClientVerdictRecord } from "@stackbase/docstore";

/** The durable per-tab dedup key threaded from the wire (`Mutation.clientId`/`seq`). */
export interface DedupKey {
  clientId: string;
  seq: number;
}

// The `CommitGuardUnit.meta` keys the receipts guard reads (the dedup key rides the EXISTING meta
// channel — no `CommitUnit`/`CommitGuardUnit` shape change, the T2/T4 de-conflict). `seq` is
// stringified only at this meta boundary (wire/store keep it a JS number — verdict Risk R10).
export const DEDUP_META_CLIENT_ID = "clientId";
export const DEDUP_META_SEQ = "seq";
export const DEDUP_META_IDENTITY = "identity";

/** Anonymous clients key as identity `""` (verdict §(c)). */
function identityKey(identity: string | null): string {
  return identity ?? "";
}

/** Map a stored `ClientVerdictRecord` to the wire replay shape (verdict §(c) "Classification"). */
export function replayFromRecord(rec: ClientVerdictRecord): ClientReplay {
  if (rec.verdict === "applied") {
    return {
      verdict: "applied",
      commitTs: Number(rec.commitTs),
      ...(rec.hasValue ? { value: rec.value as JSONValue } : { valueMissing: true }),
    };
  }
  return { verdict: "failed", commitTs: Number(rec.commitTs), code: rec.errorCode ?? "MUTATION_FAILED" };
}

/**
 * The classification pre-read: a recorded verdict short-circuits to a replay (no run); a `seq` at or
 * below the floor with no record is `stale` (loudly disowned, never re-executed — verdict §(b)); a
 * miss above the floor returns `null` → the caller RUNS the mutation with the dedup key on the commit
 * meta. Reads the verdict BEFORE the floor so a still-present record always wins over a floor that
 * happens to cover its seq (a floor never regresses, but a record can outlive being covered).
 */
export async function classifyDedup(
  store: DocStore,
  identity: string | null,
  dedup: DedupKey,
): Promise<ClientReplay | null> {
  const id = identityKey(identity);
  const rec = await store.getClientVerdict(id, dedup.clientId, dedup.seq);
  if (rec) return replayFromRecord(rec);
  const floor = await store.getClientFloor(id, dedup.clientId);
  if (floor !== null && dedup.seq <= floor) return { verdict: "stale", code: "STALE_CLIENT" };
  return null;
}

/** The read-only `Connect`-handshake classifier (verdict §(e)): the same read as {@link classifyDedup}
 *  but a miss maps to `"unknown"` (never seen — the client should resend) rather than "run now". */
export async function classifyForConnect(
  store: DocStore,
  identity: string | null,
  clientId: string,
  seq: number,
): Promise<ClientMutationVerdict> {
  const replay = await classifyDedup(store, identity, { clientId, seq });
  if (replay === null) return { clientId, seq, verdict: "unknown" };
  return { clientId, seq, ...replay };
}

/** Build the commit meta that carries the dedup key to the receipts guard (merged onto any base
 *  meta, e.g. fleet's `idempotencyKey` — the two guards read disjoint keys, verdict Risk R2). */
export function dedupCommitMeta(
  identity: string | null,
  dedup: DedupKey,
  base?: Record<string, string>,
): Record<string, string> {
  return {
    ...(base ?? {}),
    [DEDUP_META_IDENTITY]: identityKey(identity),
    [DEDUP_META_CLIENT_ID]: dedup.clientId,
    [DEDUP_META_SEQ]: String(dedup.seq),
  };
}

/**
 * Handle an error thrown by a dedup-keyed run (verdict §(c)):
 *  - the receipts guard's `CLIENT_MUTATION_DUP` PK collision (this attempt lost the commit race) →
 *    re-read the winner's row and replay-ack it (or, if the winner isn't visible yet, `null` → the
 *    caller rethrows the retryable rejection);
 *  - a DETERMINISTIC terminal app error (not retryable — a handler throw, validation, authz) → record
 *    a standalone `failed` verdict (skip-and-record poison default; `ON CONFLICT DO NOTHING` makes a
 *    concurrent poison-resend race harmless) and return `null` → the caller rethrows the original;
 *  - a transient/conflict error (retryable) → record nothing, return `null` → the caller rethrows so
 *    the client retries with backoff.
 */
export async function handleDedupError(
  store: DocStore,
  identity: string | null,
  dedup: DedupKey,
  e: unknown,
): Promise<ClientReplay | null> {
  const id = identityKey(identity);
  if (e instanceof CommitGuardRejection && e.rejectionCode === "CLIENT_MUTATION_DUP") {
    const rec = await store.getClientVerdict(id, dedup.clientId, dedup.seq);
    return rec ? replayFromRecord(rec) : null;
  }
  if (!isRetryableError(e)) {
    const code = isStackbaseError(e) ? e.code : "MUTATION_FAILED";
    await store.recordClientVerdict(id, dedup.clientId, dedup.seq, { verdict: "failed", commitTs: 0n, errorCode: code });
  }
  return null;
}

/** Record the `applied` receipt for a ZERO-WRITE successful mutation (verdict §(c) Risk R1 / OUTBOX-A
 *  T1 controller decision): a no-doc commit never reaches the store, so the receipts guard never runs
 *  for it — its receipt (WITH the return value) is written standalone here, post-run. A mutation that
 *  DID write documents gets its receipt from the guard instead, and this is a no-op for it. */
export async function recordZeroWriteApplied(
  store: DocStore,
  identity: string | null,
  dedup: DedupKey,
  commitTs: bigint,
  value: Value,
): Promise<void> {
  await store.recordClientVerdict(identityKey(identity), dedup.clientId, dedup.seq, {
    verdict: "applied",
    commitTs,
    value: convexToJson(value),
  });
}

/**
 * Best-effort post-run value fill for a COMMITTED WRITE mutation's guard-inserted `applied` receipt
 * (the B3 pattern — `LeaseManager.recordIdempotencyValue`'s sibling for client receipts; T5-review
 * recommendation). `clientReceiptsGuard` only ever sees `commitTs` when it INSERTs the receipt inside
 * the commit transaction (the return VALUE isn't known there) — this fills it in AFTER the run
 * returns, via `DocStore.updateClientVerdictValue`, so a later `applied` replay carries the real value
 * instead of `valueMissing`. Errors are swallowed here (never rethrown): a failure must NOT fail an
 * otherwise-successful mutation response — a replay for this seq then reports `valueMissing: true`
 * forever, the SAME outcome as the pre-existing crash-window gap (the value UPDATE never having run at
 * all), which Plan B's client already tolerates via the wire's `valueMissing` field. Call ONLY when
 * this node's OWN commit ran the guard (a fresh commit with dedup — never for a replay, and never for
 * a forwarded write whose guard ran on a DIFFERENT node's store).
 */
export async function fillWriteMutationValue(
  store: DocStore,
  identity: string | null,
  dedup: DedupKey,
  value: Value,
): Promise<void> {
  try {
    await store.updateClientVerdictValue(identityKey(identity), dedup.clientId, dedup.seq, convexToJson(value));
  } catch {
    // Best-effort — see the doc comment above. A later replay for this seq simply reports
    // `valueMissing: true`, same as the pre-existing crash-window gap.
  }
}

/**
 * The `applied`-receipt commit guard (registered ONCE at runtime construction, BEFORE fleet's epoch
 * fence — verdict §(c) Risk R6). For every unit whose `meta` carries a dedup key, INSERTs the
 * `client_mutations` receipt at that unit's own `ts`, inside the mutation's commit transaction. The
 * INSERT is PLAIN (never `ON CONFLICT DO NOTHING`): a PK collision IS the dedup signal — it means a
 * concurrent duplicate already committed this seq, so we throw a typed {@link CommitGuardRejection}
 * (`CLIENT_MUTATION_DUP`) carrying this unit's index. On the single-commit path it propagates as this
 * mutation's own rejection (the caller replay-reads the winner); under group commit the transactor's
 * split-retry rejects ONLY this unit and re-flushes the innocent remainder. A unit with no dedup key
 * (every ordinary mutation) is skipped — the whole guard costs a deployment nothing until the outbox
 * is used.
 *
 * Store-agnostic by querier shape (verdict Risk R9 — the guard is ONE closure, not two): a Postgres
 * `PgQuerier` exposes async `query()`; a `SqliteGuardQuerier` exposes synchronous `run()`. The SQLite
 * branch runs fully synchronously and returns `undefined` (void) — it MUST, because SQLite's commit
 * is one synchronous transaction that cannot await a guard (a returned thenable there is a dev-time
 * error). The Postgres branch returns a Promise the async `commitWriteBatch` awaits.
 */
export function clientReceiptsGuard(): (
  q: unknown,
  units: readonly CommitGuardUnit[],
  shardId: ShardId,
) => void | Promise<void> {
  const INSERT = `INSERT INTO client_mutations (identity, client_id, seq, verdict, commit_ts, value_json, error_code, created_at)`;
  return (q, units) => {
    const pg = q as { query?: (text: string, params?: readonly unknown[]) => Promise<unknown> };
    if (typeof pg.query === "function") {
      // Postgres: async — return the awaited chain.
      return (async () => {
        for (let i = 0; i < units.length; i++) {
          const dedup = readUnitDedup(units[i]!);
          if (!dedup) continue;
          try {
            await pg.query!(
              `${INSERT} VALUES ($1, $2, $3, 'applied', $4, NULL, NULL, $5)`,
              [dedup.identity, dedup.clientId, BigInt(dedup.seq), units[i]!.ts, BigInt(Date.now())],
            );
          } catch (e) {
            throw toDupOrRethrow(e, i, dedup);
          }
        }
      })();
    }
    // SQLite: synchronous — no Promise may escape.
    const sq = q as { run: (sql: string, ...params: unknown[]) => void };
    for (let i = 0; i < units.length; i++) {
      const dedup = readUnitDedup(units[i]!);
      if (!dedup) continue;
      try {
        sq.run(
          `${INSERT} VALUES (?, ?, ?, 'applied', ?, NULL, NULL, ?)`,
          dedup.identity,
          dedup.clientId,
          dedup.seq,
          units[i]!.ts,
          Date.now(),
        );
      } catch (e) {
        throw toDupOrRethrow(e, i, dedup);
      }
    }
    return undefined;
  };
}

function readUnitDedup(unit: CommitGuardUnit): { identity: string; clientId: string; seq: number } | null {
  const meta = unit.meta;
  const clientId = meta?.[DEDUP_META_CLIENT_ID];
  const seqStr = meta?.[DEDUP_META_SEQ];
  if (clientId === undefined || seqStr === undefined) return null;
  return { identity: meta![DEDUP_META_IDENTITY] ?? "", clientId, seq: Number(seqStr) };
}

/** Convert a PK-collision driver error to the typed `CLIENT_MUTATION_DUP` rejection; rethrow anything
 *  else. Postgres uses SQLSTATE `23505`; SQLite exposes a `SQLITE_CONSTRAINT*` code on some drivers
 *  and only a message (`node:sqlite`/`bun:sqlite`) on others. The `client_mutations` PK is the ONLY
 *  unique constraint this INSERT can violate, so a unique-violation here is unambiguously the dedup
 *  collision — matching the message is safe. */
function toDupOrRethrow(e: unknown, unitIndex: number, dedup: { clientId: string; seq: number }): unknown {
  const code = String((e as { code?: unknown }).code ?? "");
  const message = String((e as { message?: unknown })?.message ?? "");
  const isUniqueViolation =
    code === "23505" || code.startsWith("SQLITE_CONSTRAINT") || /unique constraint failed/i.test(message);
  if (isUniqueViolation) {
    return new CommitGuardRejection(unitIndex, "CLIENT_MUTATION_DUP", `client=${dedup.clientId} seq=${dedup.seq}`, {
      cause: e,
    });
  }
  return e;
}
