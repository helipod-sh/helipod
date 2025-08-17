import { httpRouter, httpAction } from "@stackbase/executor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ping = httpAction(async (_ctx: any, req: Request) => {
  const body = await req.json();
  return new Response(JSON.stringify({ pong: body.n }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

// Surfaces the ambient identity (via the `identityProbe` test component, when composed) so a test
// can assert `t.fetch`'s identity threading — a view's `withIdentity` vs. the raw `Authorization`
// header on the `Request` itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const whoami = httpAction(async (ctx: any) => {
  return new Response(JSON.stringify({ identity: ctx.probe.get() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const http = httpRouter();
http.route({ path: "/webhooks/ping", method: "POST", handler: ping });
http.route({ path: "/whoami", method: "GET", handler: whoami });

export default http;
