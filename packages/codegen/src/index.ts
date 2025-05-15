/**
 * `@stackbase/codegen` — generates the typed client surface (`_generated/`) from a schema
 * and an analyzed function manifest. The end-to-end types that make Stackbase feel like Convex.
 */
export type { TypeEmitContext } from "./validator-to-ts";
export { validatorToTsType, validatorToJson } from "./validator-to-ts";

export type {
  UdfType,
  Visibility,
  AnalyzedFunction,
  AnalyzedModule,
  AnalyzedFunctionManifest,
  GeneratedFile,
  GeneratedBundle,
  CodegenOptions,
  CodegenInput,
} from "./generate";
export { generateDataModel, generateApi, generateServer, generateAll } from "./generate";

export type { WriteResult } from "./write";
export { writeGenerated } from "./write";
