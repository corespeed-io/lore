import { expect, test } from "vitest";
import {
  embeddingConfiguration as configuredEmbeddingConfiguration,
  DEFAULT_EMBEDDING_CONFIGURATION,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROTOCOL_REVISION,
  embeddingBuildEnvironment,
  embeddingConfigurationFromEnvironment,
  QWEN3_EMBEDDING_PROTOCOL_REVISION,
} from "@/server/providers/embedding/config";

/** lore oss's policy pins the engine's dimension parameter to 1024. */
function embeddingConfiguration(input: { provider: string; model: string }) {
  return configuredEmbeddingConfiguration({ ...input, dimensions: EMBEDDING_DIMENSIONS });
}

test("local deployments default to Qwen inside the fixed Lore v1 embedding protocol", () => {
  expect(DEFAULT_EMBEDDING_CONFIGURATION).toEqual({
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: EMBEDDING_DIMENSIONS,
    revision: QWEN3_EMBEDDING_PROTOCOL_REVISION,
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
    revision: EMBEDDING_PROTOCOL_REVISION,
  });
});

test("each provider has a valid default model when only the provider is selected", () => {
  expect(embeddingConfigurationFromEnvironment({ LORE_EMBEDDING_PROVIDER: "google" })).toEqual({
    provider: "google",
    model: "gemini-embedding-2",
    dimensions: 1024,
    revision: EMBEDDING_PROTOCOL_REVISION,
  });
  expect(embeddingConfigurationFromEnvironment({ LORE_EMBEDDING_PROVIDER: "vercel" })).toEqual({
    provider: "vercel",
    model: "openai/text-embedding-3-small",
    dimensions: 1024,
    revision: EMBEDDING_PROTOCOL_REVISION,
  });
});

test("gateway-routed models keep an embedding-space identity of their own", () => {
  const gateway = embeddingConfiguration({
    provider: "vercel",
    model: "openai/text-embedding-3-small",
  });
  const native = embeddingConfiguration({ provider: "openai", model: "text-embedding-3-small" });

  expect(gateway.revision).toBe(native.revision);
  expect(gateway.provider).not.toBe(native.provider);
});

test("only Qwen3 Ollama models opt into the v2 query preprocessing space", () => {
  expect(
    embeddingConfiguration({
      provider: "ollama",
      model: "hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0",
    }).revision,
  ).toBe(QWEN3_EMBEDDING_PROTOCOL_REVISION);
  expect(embeddingConfiguration({ provider: "ollama", model: "nomic-embed-text" }).revision).toBe(
    EMBEDDING_PROTOCOL_REVISION,
  );
});

test("deployment configuration rejects dimension overrides", () => {
  expect(() =>
    embeddingConfigurationFromEnvironment({
      LORE_EMBEDDING_PROVIDER: "google",
      LORE_EMBEDDING_DIMENSIONS: "1536",
    }),
  ).toThrow("LORE_EMBEDDING_DIMENSIONS is not configurable");
});

test("embedding rollout requires an explicit build provider and model pair", () => {
  expect(embeddingBuildEnvironment({})).toBeUndefined();
  expect(() => embeddingBuildEnvironment({ LORE_EMBEDDING_BUILD_PROVIDER: "google" })).toThrow(
    "LORE_EMBEDDING_BUILD_PROVIDER and LORE_EMBEDDING_BUILD_MODEL must be set together",
  );
  expect(
    embeddingBuildEnvironment({
      LORE_EMBEDDING_PROVIDER: "ollama",
      LORE_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
      LORE_EMBEDDING_BUILD_PROVIDER: "google",
      LORE_EMBEDDING_BUILD_MODEL: "gemini-embedding-2",
    }),
  ).toMatchObject({
    LORE_EMBEDDING_PROVIDER: "google",
    LORE_EMBEDDING_MODEL: "gemini-embedding-2",
  });
});
