import { defineSchema } from "@stackbase/values";

// Destructive: drops the `notes` table entirely relative to v1/v2's live schema. `diffSchema`
// must reject this deploy so a rejected apply never leaves the running deployment mid-swap.
export default defineSchema({});
