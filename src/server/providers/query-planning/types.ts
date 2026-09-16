import type { QueryPlanningProvider } from "@corespeed/lore-core";
import type { ModelProviderMetadata } from "../metadata";

export interface ConfiguredQueryPlanningProvider
  extends QueryPlanningProvider,
    ModelProviderMetadata {}
