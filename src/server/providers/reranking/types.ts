import type { RerankingProvider } from "@corespeed/lore-core";
import type { ModelProviderMetadata } from "../metadata";

export interface ConfiguredRerankingProvider extends RerankingProvider, ModelProviderMetadata {}
