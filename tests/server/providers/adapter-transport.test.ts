import { expect, test } from "vitest";
import { createGoogleEmbeddingProvider } from "@/server/providers/embedding/google";
import {
  createOpenAIEmbeddingProvider,
  createVercelAIGatewayEmbeddingProvider,
} from "@/server/providers/embedding/openai-compatible";
import { createGoogleQueryPlanningProvider } from "@/server/providers/query-planning/google";
import { createHostedRerankingProvider } from "@/server/providers/reranking/hosted";

// Every adapter that always sends a credential applies the shared base-URL rule:
// plain HTTP only on loopback or the Docker-host bridge. Google and OpenAI
// embeddings used to accept plain HTTP to any host, carrying the deployment key.

const embedding = (provider: "google" | "openai" | "vercel", model: string) => ({
  provider,
  model,
  dimensions: 1024 as const,
  revision: "lore-embedding-v1",
});

const credentialBearingAdapters: ReadonlyArray<readonly [string, (baseUrl: string) => unknown]> = [
  [
    "Google embedding",
    (baseUrl) =>
      createGoogleEmbeddingProvider(embedding("google", "gemini-embedding-2"), {
        apiKey: "test-google-key",
        baseUrl,
      }),
  ],
  [
    "OpenAI embedding",
    (baseUrl) =>
      createOpenAIEmbeddingProvider(embedding("openai", "text-embedding-3-small"), {
        apiKey: "test-openai-key",
        baseUrl,
      }),
  ],
  [
    "Vercel AI Gateway embedding",
    (baseUrl) =>
      createVercelAIGatewayEmbeddingProvider(embedding("vercel", "openai/text-embedding-3-small"), {
        apiKey: "test-gateway-key",
        baseUrl,
      }),
  ],
  [
    "Google query planner",
    (baseUrl) =>
      createGoogleQueryPlanningProvider({
        model: "gemini-2.5-flash",
        apiKey: "test-google-key",
        baseUrl,
      }),
  ],
  ...(["cohere", "voyage", "memos"] as const).map(
    (provider) =>
      [
        `${provider} reranking`,
        (baseUrl: string) =>
          createHostedRerankingProvider({
            provider,
            model: "rerank-model",
            apiKey: "test-rerank-key",
            baseUrl,
          }),
      ] as const,
  ),
];

test("credential-bearing adapters refuse plain HTTP outside loopback without echoing the URL", () => {
  for (const [name, create] of credentialBearingAdapters) {
    for (const baseUrl of ["http://models.example.com", "http://operator:secret@10.0.0.5:8000"]) {
      let message = "";
      try {
        create(baseUrl);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `${name} ${baseUrl}`).toMatch(
        /base URL must use https outside loopback or host\.docker\.internal$/,
      );
      expect(message, name).not.toContain("secret");
      expect(message, name).not.toContain("example.com");
    }
  }
});

test("credential-bearing adapters still reach loopback, the Docker-host bridge, and HTTPS", () => {
  for (const [name, create] of credentialBearingAdapters) {
    for (const baseUrl of [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://[::1]:8080",
      "http://host.docker.internal:8080",
      "https://models.example.com",
    ]) {
      expect(() => create(baseUrl), `${name} ${baseUrl}`).not.toThrow();
    }
  }
});
