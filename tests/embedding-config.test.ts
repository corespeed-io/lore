import { expect, test } from "vitest";
import {
  DEFAULT_EMBEDDING_CONFIGURATION,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROTOCOL_REVISION,
  embeddingConfiguration,
  embeddingConfigurationFromEnvironment,
} from "@/lib/embedding-config";

test("local deployments default to Qwen inside the fixed Lore v1 embedding protocol", () => {
  expect(DEFAULT_EMBEDDING_CONFIGURATION).toEqual({
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: EMBEDDING_DIMENSIONS,
    revision: EMBEDDING_PROTOCOL_REVISION,
  });
});

test("self-host operators can choose a provider and model but not dimensions", () => {
  expect(
    embeddingConfiguration({
      provider: "openai",
      model: "text-embedding-3-large",
    }),
  ).toEqual({
    provider: "openai",
    model: "text-embedding-3-large",
    dimensions: 1024,
    revision: "lore-embedding-v1",
  });
});

test("each provider has a valid default model when only the provider is selected", () => {
  expect(embeddingConfigurationFromEnvironment({ LORE_EMBEDDING_PROVIDER: "google" })).toEqual({
    provider: "google",
    model: "gemini-embedding-2",
    dimensions: 1024,
    revision: "lore-embedding-v1",
  });
});

test("deployment configuration rejects dimension overrides", () => {
  expect(() =>
    embeddingConfigurationFromEnvironment({
      LORE_EMBEDDING_PROVIDER: "google",
      LORE_EMBEDDING_DIMENSIONS: "1536",
    }),
  ).toThrow("LORE_EMBEDDING_DIMENSIONS is not configurable");
});
