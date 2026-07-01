import { httpAction, httpRouter } from "./_generated/server";

/**
 * A minimal public HTTP endpoint: `httpAction`s are `Request -> Response` handlers routed by
 * `http.ts`'s default-exported `httpRouter()`, dispatched by the dev server after its own
 * built-ins (`/api/*`, `/_*` are reserved and always win — see `isReservedHttpPath`).
 *
 * Kept self-contained (reads a query param, no `ctx.runMutation`) so this example doesn't need
 * app data beyond what's already here. The webhook -> ctx.runMutation -> reactive fan-out proof
 * lives in its own fixture in `packages/cli/test/http-action-e2e.test.ts`.
 */
export const ping = httpAction(async (_ctx, request) => {
  const who = new URL(request.url).searchParams.get("who") ?? "anon";
  return new Response(JSON.stringify({ ok: true, who }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const http = httpRouter();
http.route({ path: "/ping", method: "GET", handler: ping });
export default http;
