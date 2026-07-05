import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents, type ComponentDefinition, type Driver } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema, type SchemaDefinitionJSON } from "@helipod/values";
import { mutation, query, type RegisteredFunction } from "@helipod/executor";
import { NotificationSendError, type EmailProvider, type SmsProvider, type EmailMessage, type SmsMessage } from "../src/provider";

/** A privileged raw-table scan so tests can assert on the component's own namespaced tables
 *  (e.g. "notifications/messages"). Mirrors `components/scheduler/test/helpers.ts`. */
function systemModules(): Record<string, RegisteredFunction> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "_system:scan": query(async (ctx: any, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
    // N2 retry-reclaim test seam: claim a `queued` row WITHOUT calling `_markResult`, so a test can
    // simulate a crash between claim and mark (a stuck "sending" row) and assert reclaim behavior.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "_system:claim": mutation(async (ctx: any, a: { messageId: string }) => {
      const row = await ctx.db.get(a.messageId);
      if (!row || row.status !== "queued") return false;
      await ctx.db.replace(a.messageId, { ...row, status: "sending", claimedAt: ctx.now() });
      return true;
    }),
    // N4 digest test seam: backdate every un-flushed `digestBuffer` row's `createdAt` to 0, so any
    // `now` the driver ticks with is past a digest category's rolling window — test-only, no wire
    // path exercises "time travel" for a digest window.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "_system:backdateDigest": mutation(async (ctx: any) => {
      const rows = await ctx.db.query("notifications/digestBuffer", "byUnflushed").collect();
      for (const r of rows) await ctx.db.replace(r._id, { ...r, createdAt: 0 });
      return null;
    }),
  };
}

export interface BuiltNotifRuntime {
  runtime: EmbeddedRuntime;
  driver?: Driver & { __tick?: () => Promise<void> };
  readTable(name: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * Compose a notifications ComponentDefinition (assembled inline by each test — so a test needs only
 * its own task's files, not the full `defineNotifications`) plus optional app modules, and return a
 * live EmbeddedRuntime. Grabs the notifications driver (if the component declares one) for `__tick`.
 */
export async function makeNotifRuntime(
  component: ComponentDefinition,
  appModules: Record<string, RegisteredFunction> = {},
): Promise<BuiltNotifRuntime> {
  const schemaJson: SchemaDefinitionJSON = defineSchema({}).export();
  const composed = composeComponents({ schemaJson, moduleMap: appModules }, [component]);
  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog,
    modules: composed.moduleMap,
    systemModules: systemModules(), // `_system:*` is off the public `run` surface — reached via `runSystem`
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
    policyRegistry: composed.policyRegistry,
    policyProviders: composed.policyProviders,
    relationRegistry: composed.relationRegistry,
    bootSteps: composed.bootSteps,
    drivers: composed.drivers,
    tableNumbers: composed.tableNumbers,
  });
  const driver = composed.drivers.find((d) => d.name === "notifications") as (Driver & { __tick?: () => Promise<void> }) | undefined;
  return {
    runtime,
    driver,
    readTable: async (name) => (await runtime.runSystem<Record<string, unknown>[]>("_system:scan", { table: name })).value ?? [],
    close: async () => { await runtime.stopDrivers(); },
  };
}

/** In-memory capture email provider (never delivers). Records every `send` for assertions.
 *  A forced failure is thrown as a non-retryable `NotificationSendError` (N2) — the N1 driver test
 *  using `{fail:true}` asserts an IMMEDIATE terminal `"failed"` after one delivery attempt, which
 *  requires `retryable:false` under N2's retry-by-default `_markResult` (a plain `Error` would retry
 *  up to `config.retry.maxAttempts` before dead-lettering instead). */
export function captureEmail(opts?: { fail?: boolean }): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    provider: {
      channel: "email",
      async send(m) {
        sent.push(m);
        if (opts?.fail) throw new NotificationSendError("capture-email forced failure", { retryable: false });
        return { providerMessageId: `cap-${sent.length}` };
      },
    },
  };
}

/** In-memory capture SMS provider. Same non-retryable forced-failure choice as `captureEmail` above. */
export function captureSms(opts?: { fail?: boolean }): { sent: SmsMessage[]; provider: SmsProvider } {
  const sent: SmsMessage[] = [];
  return {
    sent,
    provider: {
      channel: "sms",
      async send(m) {
        sent.push(m);
        if (opts?.fail) throw new NotificationSendError("capture-sms forced failure", { retryable: false });
        return { providerMessageId: `sms-${sent.length}` };
      },
    },
  };
}
