import { defineComponent } from "@stackbase/component";
import { authSchema } from "./schema";
import { signUp, signIn } from "./functions";

export const auth = defineComponent({ name: "auth", schema: authSchema, modules: { signUp, signIn } });
