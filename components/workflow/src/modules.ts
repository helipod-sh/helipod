import { query, mutation } from "@stackbase/executor";
import type { QueryCtx, MutationCtx, RegisteredFunction } from "@stackbase/executor";
import type { WorkflowRegistry } from "./registry";

/**
 * `workflow:status` — a QUERY: reads a `workflows` row by id and projects it down to the
 * client-facing shape (`state`/`result`/`error`), or `null` if the run doesn't exist. Read-only,
 * so it needs no `contextWrite` — registered directly on `defineWorkflow()`'s `modules` map (see
 * `./index.ts`), reachable at `workflow:status`.
 */
export const status = query(async (ctx: QueryCtx, a: { runId: string }) => {
  const wf = await ctx.db.get(a.runId);
  if (wf === null) return null;
  return { state: wf.state as string, result: wf.result, error: wf.error as string | undefined };
});

/**
 * `workflow:_advance` — a MUTATION, enqueued by `ctx.workflow.start` (`./facade.ts`) via
 * `scheduler.enqueue("workflow:_advance", { workflowId }, ...)`. This is a deliberate STUB for
 * Task 1: the real replay loop (looking up the workflow's registered handler by
 * `workflowFnPath`, driving it forward through the durable `steps` journal, and transitioning
 * `workflows.state` to `"completed"`/`"failed"`) is Task 2. For now it just no-ops, leaving
 * `state` unchanged (`"running"`) — `_workflows` (the registry passed to `defineWorkflow`) is
 * accepted but not yet consulted, hence the `_` prefix on the parameter.
 */
export function makeAdvance(_workflows: WorkflowRegistry): RegisteredFunction {
  return mutation(async (_ctx: MutationCtx, _a: { workflowId: string }) => null);
}
