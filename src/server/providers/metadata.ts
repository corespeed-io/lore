import type { QueryPlanningProvider, RerankingProvider } from "@corespeed/lore-core";

/** Model provenance and execution settings recorded by OSS diagnostics and benchmarks. */
export interface ModelProviderMetadata {
  provider: string;
  model: string;
  revision?: string;
  transport?: string;
  instruction?: string;
  decoding?: Record<string, unknown>;
  keepAlive?: string | number;
}

export interface ConfiguredQueryPlanningProvider
  extends QueryPlanningProvider,
    ModelProviderMetadata {}

export interface ConfiguredRerankingProvider extends RerankingProvider, ModelProviderMetadata {}
