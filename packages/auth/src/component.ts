import { defineComponent } from "@stackbase/component";
import { authSchema } from "./schema";
import { signUp, signIn, signOut, getUserId } from "./functions";
import { authContext } from "./context";

export const auth = defineComponent({ name: "auth", schema: authSchema, modules: { signUp, signIn, signOut, getUserId }, context: authContext });
