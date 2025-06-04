import type { ComponentDefinition } from "./define-component";

export interface StackbaseConfig {
  components: ComponentDefinition[];
}

export function defineConfig(config: StackbaseConfig): StackbaseConfig {
  return config;
}
