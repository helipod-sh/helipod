import type { SchemaDefinition, Validator } from "@stackbase/values";
import type { RegisteredFunction, TablePolicy, PolicyContextProvider, GuestDatabaseWriter } from "@stackbase/executor";
import type { ComponentContext } from "@stackbase/executor";

export interface BootContext { db: GuestDatabaseWriter; now: number }

export interface ComponentDefinition {
  name: string;
  schema: SchemaDefinition;
  modules: Record<string, RegisteredFunction>;
  config?: Validator<unknown>;
  requires?: string[];
  grants?: Record<string, { read?: string[]; write?: string[] }>;
  /** Optional facade contributed to every function's ctx as ctx[name]. Runs in this component's namespace. */
  context?: (cctx: ComponentContext) => object;
  /** The TS type this component contributes to ctx, for codegen: ctx[name]: import(import).type. */
  contextType?: { import: string; type: string };
  /** Row policies this component declares for app tables: table → { read?, write? }. */
  policies?: Record<string, TablePolicy>;
  /** Contributes fields to every row policy's rule-context (e.g. authz → `{ auth }`). */
  policyContext?: PolicyContextProvider["build"];
  /** A once-per-process startup step (migrations/index rebuilds). Runs namespaced + non-user. */
  boot?: (ctx: BootContext) => Promise<void>;
}

export function defineComponent(def: ComponentDefinition): ComponentDefinition {
  if (!def.name) throw new Error("component name must be non-empty");
  if (def.name.startsWith("_") || def.name === "app") throw new Error(`component name "${def.name}" is reserved`);
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
    throw new Error(`component name "${def.name}" may contain only letters, digits, underscores (no "/" or ":")`);
  }
  if (def.contextType && !def.context) {
    throw new Error(
      `component "${def.name}" declares contextType but no context builder — ctx.${def.name} would be typed but undefined at runtime`,
    );
  }
  return def;
}
