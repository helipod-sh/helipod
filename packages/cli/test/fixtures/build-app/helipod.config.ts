import { defineScheduler } from "@helipod/scheduler";

// Composes `@helipod/scheduler` on purpose — exercises config-based component reconstruction
// through the real `bun build --compile` entrypoint, not just the in-process `helipod dev` path.
export default { components: [defineScheduler()] };
