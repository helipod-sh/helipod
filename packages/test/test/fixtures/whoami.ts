import { defineComponent } from "@helipod/component";
import { defineSchema } from "@helipod/values";
import { query } from "@helipod/executor";

// A tiny component whose context facade exposes the ambient identity token (the real, faithful
// path — cctx.identity is what components/auth's ctx.auth reads). `modules`/`schema` are required.
// Also defines `buildAction` (the action/httpAction-mode counterpart) with the same `get()` shape,
// so the SAME probe works from a query (`context`) as well as an action/httpAction (`buildAction`)
// — see `packages/component/src/define-component.ts`'s note on why the two are separate.
export const identityProbe = defineComponent({
  name: "probe",
  schema: defineSchema({}),
  modules: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: (cctx: any) => ({ get: () => cctx.identity ?? null }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildAction: (api: any) => ({ get: () => api.identity ?? null }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const me = query(async (ctx: any) => ctx.probe.get());
