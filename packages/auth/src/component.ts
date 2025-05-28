import { defineComponent } from "@stackbase/component";
import { authSchema } from "./schema";
import { signUp, signIn, signOut, getUserId } from "./functions";

export const auth = defineComponent({ name: "auth", schema: authSchema, modules: { signUp, signIn, signOut, getUserId } });
