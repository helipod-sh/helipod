/**
 * `stackbase fleet` — the CLI entrypoint for offline fleet maintenance operations that live in the
 * enterprise `@stackbase/fleet` package. Today: `fleet reshard` (B5 Part 1, Task 9.2), which changes
 * a STOPPED Postgres fleet's shard count. Core `packages/cli` keeps ZERO static dependency on
 * `@stackbase/fleet` — it's loaded only via dynamic `import()`, mirroring `serve --fleet`'s gate
 * (`serve.ts`'s `fleetSpecifier`/`FLEET_ERR_NO_PACKAGE`).
 */
import { isPostgresUrl, makePgClient } from "./boot";

/** The slice of `@stackbase/fleet`'s reshard surface `fleetCommand` consumes (via dynamic import).
 *  Declared locally (structural, not imported) for the same reason `serve.ts`'s `FleetModule` is —
 *  keep core `packages/cli` free of a static/type dependency on the enterprise package. Keep in sync
 *  with `ee/packages/fleet/src/reshard.ts`. */
export interface ReshardResult {
  previousShards: number;
  newShards: number;
  created: string[];
  deleted: string[];
  frontierFloor: string;
}

export interface FleetModule {
  reshardFleet(client: unknown, opts: { targetShards: number }): Promise<ReshardResult>;
  ReshardFleetLiveError: new (...args: unknown[]) => Error;
  ReshardVerificationError: new (...args: unknown[]) => Error;
}

/** Same message shape as `serve.ts`'s `FLEET_ERR_NO_PACKAGE` — kept as an independent literal (no
 *  cross-file import) since the two commands' failure paths are otherwise unrelated. */
export const FLEET_ERR_NO_PACKAGE = "fleet mode requires @stackbase/fleet — install it (bun add @stackbase/fleet).";

interface ReshardArgs {
  targetShards: number;
  databaseUrl: string;
}

/** Parse `fleet reshard`'s flags. Pure — no I/O. Returns a clear `✗`-prefixed error string on any
 *  missing/invalid flag, or the validated args on success. */
export function parseReshardArgs(args: string[]): { ok: true; args: ReshardArgs } | { ok: false; error: string } {
  let shardsRaw: string | undefined;
  let databaseUrl: string | undefined = process.env.STACKBASE_DATABASE_URL;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--shards" && args[i + 1]) shardsRaw = args[++i];
    else if (a === "--database-url" && args[i + 1]) databaseUrl = args[++i];
  }

  if (shardsRaw === undefined) {
    return { ok: false, error: "✗ --shards <M> is required — e.g. --shards 4" };
  }
  const targetShards = Number(shardsRaw);
  if (!Number.isInteger(targetShards) || targetShards < 1) {
    return { ok: false, error: `✗ --shards must be an integer >= 1, got ${JSON.stringify(shardsRaw)}` };
  }

  if (!isPostgresUrl(databaseUrl)) {
    return {
      ok: false,
      error: "✗ --database-url postgres://… is required (or STACKBASE_DATABASE_URL) — fleet reshard is Postgres-only",
    };
  }

  return { ok: true, args: { targetShards, databaseUrl: databaseUrl! } };
}

/** `fleet reshard --shards M --database-url <pg>`: dynamically import `@stackbase/fleet`, open a
 *  short-lived PgClient (via `makePgClient` — `BunSqlClient` under Bun, `NodePgClient` elsewhere),
 *  run `reshardFleet`, and print a clear result. Returns the process exit
 *  code (0 on success, 1 on any validation/refusal/error). */
async function reshardCommand(args: string[]): Promise<number> {
  const parsed = parseReshardArgs(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error + "\n");
    return 1;
  }
  const { targetShards, databaseUrl } = parsed.args;

  let fleetModule: FleetModule;
  try {
    // Indirect specifier (typed `string`, not a literal) so tsc does NOT statically resolve
    // `@stackbase/fleet` — mirrors `serve.ts`'s `fleetSpecifier` gate.
    const fleetSpecifier: string = "@stackbase/fleet";
    fleetModule = (await import(fleetSpecifier)) as unknown as FleetModule;
  } catch {
    process.stderr.write(`✗ ${FLEET_ERR_NO_PACKAGE}\n`);
    return 1;
  }

  const client = makePgClient(databaseUrl);
  try {
    const result = await fleetModule.reshardFleet(client, { targetShards });
    process.stdout.write(
      `✓ resharded ${result.previousShards} → ${result.newShards} shards ` +
        `(created: ${result.created.length ? result.created.join(", ") : "none"}, ` +
        `deleted: ${result.deleted.length ? result.deleted.join(", ") : "none"}, ` +
        `frontier floor: ${result.frontierFloor}); ` +
        `update STACKBASE_FLEET_SHARDS to ${result.newShards} (or unset) before restarting the fleet\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    await client.close();
  }
}

/** `stackbase fleet <sub> [...]` — sub-dispatches on `args[0]`. Unknown/absent sub → usage error. */
export async function fleetCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "reshard":
      return reshardCommand(rest);
    default:
      process.stderr.write(
        `✗ unknown fleet subcommand: ${sub ?? "(none)"}\n` +
          `Usage: stackbase fleet reshard --shards M --database-url <url>\n`,
      );
      return 1;
  }
}
