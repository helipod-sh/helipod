import { defineConfig } from "@stackbase/component";
import { defineAuth, consoleEmail } from "@stackbase/auth";
import { defineScheduler } from "@stackbase/scheduler";
import { defineWorkflow, workflow } from "@stackbase/workflow";

// `@stackbase/scheduler`/`@stackbase/workflow` are opt-in like every other component (see
// `packages/cli/src/load-config.ts` — there is no CLI-level auto-install list). They're listed
// here, alongside `auth`, as the reference pattern real projects copy from: this is what
// "default-installed" means in this config-driven architecture — every new project that starts
// from this template gets `ctx.scheduler`/`cronJobs()` and `ctx.workflow`/durable multi-step
// workflows for free, Convex-parity, out of the box. `defineWorkflow` `requires: ["scheduler"]`
// (workflow runs are dispatched through the scheduler's job queue), so it's listed after it.

// `auth`'s `email` block turns on the A2 flows (email verification, password reset, magic-link
// and OTP sign-in — `web/main.tsx` exercises all of them). `consoleEmail()` is the zero-config dev
// provider (decision 14, `components/auth/src/email/provider.ts`): it does NOT deliver anything —
// every verification/reset/magic-link code or link is printed to the `stackbase dev` SERVER
// console (the terminal running `bun run dev`, not the browser). Watch that terminal for the code
// to paste into the demo's UI. Swap `consoleEmail()` for `resendEmail({ apiKey, from })` (or a
// custom `{ send }` provider) to actually deliver mail in a real deployment.
const auth = defineAuth({
  email: {
    provider: consoleEmail(),
    from: "no-reply@demo.test",
    appName: "Auth Demo",
    baseUrl: "http://localhost:5173",
    // On so the demo's verify banner is actually reachable: signUp/signIn of an unverified
    // account return `{ needsVerification: true }` (no session), and `web/main.tsx`'s
    // VerifyBanner drives `requestEmailVerification` → `verifyEmail` to complete sign-in.
    requireEmailVerification: true,
  },
});

// A minimal illustrative workflow — the reference pattern real projects extend: a single
// `step.runQuery` against this project's own `whoami:get` (`convex/whoami.ts`), referenced by its
// bare string path exactly like `ctx.scheduler.runAfter`'s targets are (codegen's typed
// `internal`/`api` refs work here too). Registered under the key `"workflows:sample"` — the
// `ctx.workflow.start("workflows:sample", {})` target a real app would call from a mutation/action.
const sample = workflow.define({
  handler: async (step) => step.runQuery("whoami:get", {}),
});

export default defineConfig({
  components: [auth, defineScheduler(), defineWorkflow({ workflows: { "workflows:sample": sample } })],
});
