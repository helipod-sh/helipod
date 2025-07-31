import { defineScheduler } from "@stackbase/scheduler";

// Composes `@stackbase/scheduler` on purpose — exercises config-based component reconstruction
// through the real `bun build --compile` entrypoint, not just the in-process `stackbase dev` path.
export default { components: [defineScheduler()] };
