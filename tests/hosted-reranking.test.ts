import { expect, test } from "vitest";
import { createHostedRerankingProvider } from "@/lib/reranking/hosted";

test("Cohere v2 adapter preserves authorized document ids", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createHostedRerankingProvider({
    provider: "cohere",
    model: "rerank-v4.0-pro",
    apiKey: "cohere-secret",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://api.cohere.com/v2/rerank");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cohere-secret");
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.25 },
        ],
      });
    },
  });

  await expect(
    provider.rerank({
      query: "Where did I study?",
      documents: [
        { id: "first", text: "I studied in Boston." },
        { id: "second", text: "I graduated from MIT." },
      ],
      limit: 2,
    }),
  ).resolves.toEqual([
    { documentId: "second", score: 0.95 },
    { documentId: "first", score: 0.25 },
  ]);
  expect(requestBody).toEqual({
    model: "rerank-v4.0-pro",
    query: "Where did I study?",
    documents: ["I studied in Boston.", "I graduated from MIT."],
    top_n: 2,
  });
});

test("Voyage v1 adapter uses instruction-following query and disables returned documents", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createHostedRerankingProvider({
    provider: "voyage",
    model: "rerank-2.5",
    apiKey: "voyage-secret",
    instruction: "Prefer current user facts",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://api.voyageai.com/v1/rerank");
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ data: [{ index: 0, relevance_score: 0.875 }] });
    },
  });

  await expect(
    provider.rerank({
      query: "Current employer?",
      documents: [{ id: "memory", text: "I now work at Acme." }],
      limit: 1,
    }),
  ).resolves.toEqual([{ documentId: "memory", score: 0.875 }]);
  expect(requestBody).toEqual({
    model: "rerank-2.5",
    query: "Prefer current user facts\n\nCurrent employer?",
    documents: ["I now work at Acme."],
    top_k: 1,
    return_documents: false,
    truncation: true,
  });
});

test("Memos adapter batches the official memory reranker request and globally sorts scores", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const provider = createHostedRerankingProvider({
    provider: "memos",
    model: "memos-reranker-0.6b",
    apiKey: "memos-secret",
    batchMaxCharacters: 18,
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://memos.memtensor.cn/api/openmem/v1/rerank");
      expect(new Headers(init?.headers).get("authorization")).toBe("Token memos-secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const documents = body.documents as string[];
      return Response.json({
        results: documents.map((document, index) => ({
          index,
          relevance_score: document.includes("current")
            ? 0.95
            : document.includes("related")
              ? 0.7
              : 0.1,
        })),
      });
    },
  });

  await expect(
    provider.rerank({
      query: "Where do I work now?",
      documents: [
        { id: "old", text: "old employer" },
        { id: "current", text: "current employer" },
        { id: "related", text: "related role" },
      ],
      limit: 2,
    }),
  ).resolves.toEqual([
    { documentId: "current", score: 0.95 },
    { documentId: "related", score: 0.7 },
  ]);
  expect(requests).toEqual([
    {
      model: "memos-reranker-0.6b",
      query: "Where do I work now?",
      documents: ["old employer"],
      top_n: 1,
    },
    {
      model: "memos-reranker-0.6b",
      query: "Where do I work now?",
      documents: ["current employer"],
      top_n: 1,
    },
    {
      model: "memos-reranker-0.6b",
      query: "Where do I work now?",
      documents: ["related role"],
      top_n: 1,
    },
  ]);
});

test("hosted adapter rejects duplicate indexes from a provider", async () => {
  const provider = createHostedRerankingProvider({
    provider: "cohere",
    model: "rerank-v4.0-fast",
    apiKey: "secret",
    fetch: async () =>
      Response.json({
        results: [
          { index: 0, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.7 },
        ],
      }),
  });
  await expect(
    provider.rerank({
      query: "query",
      documents: [
        { id: "first", text: "first" },
        { id: "second", text: "second" },
      ],
      limit: 2,
    }),
  ).rejects.toThrow("invalid reranking result");
});

test("hosted adapter rejects scores outside its calibrated zero-to-one contract", async () => {
  const provider = createHostedRerankingProvider({
    provider: "memos",
    model: "memos-reranker-0.6b",
    apiKey: "secret",
    fetch: async () => Response.json({ results: [{ index: 0, relevance_score: 1.25 }] }),
  });
  await expect(
    provider.rerank({
      query: "query",
      documents: [{ id: "first", text: "first" }],
      limit: 1,
    }),
  ).rejects.toThrow("invalid reranking result");
});
