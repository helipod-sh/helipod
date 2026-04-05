import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, type ComponentDefinition, type Driver } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, type SchemaDefinitionJSON } from "@stackbase/values";
import { query, type RegisteredFunction } from "@stackbase/executor";
import type { EmailProvider, SmsProvider, EmailMessage, SmsMessage } from "../src/provider";

/** A privileged raw-table scan so tests can assert on the component's own namespaced tables
 *  (e.g. "notifications/messages"). Mirrors `components/scheduler/test/helpers.ts`. */
function systemModules(): Record<string, RegisteredFunction> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "_system:scan": query(async (ctx: any, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
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

/** In-memory capture email provider (never delivers). Records every `send` for assertions. */
export function captureEmail(opts?: { fail?: boolean }): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    provider: {
      channel: "email",
      async send(m) {
        sent.push(m);
        if (opts?.fail) throw new Error("capture-email forced failure");
        return { providerMessageId: `cap-${sent.length}` };
      },
    },
  };
}

/** In-memory capture SMS provider. */
export function captureSms(opts?: { fail?: boolean }): { sent: SmsMessage[]; provider: SmsProvider } {
  const sent: SmsMessage[] = [];
  return {
    sent,
    provider: {
      channel: "sms",
      async send(m) {
        sent.push(m);
        if (opts?.fail) throw new Error("capture-sms forced failure");
        return { providerMessageId: `sms-${sent.length}` };
      },
    },
  };
}
