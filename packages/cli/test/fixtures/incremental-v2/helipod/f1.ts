import { query } from "@helipod/executor";

// f1: untouched between v1 and v2 — the incremental-push E2E asserts this module's sha lands in
// `unchanged` (never `changed`) on the v2 delta deploy, and its behavior stays byte-for-byte the
// same across the hot-swap.
export const ping = query({
  handler: async () => "v1",
});
