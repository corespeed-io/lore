import { afterEach, expect, test, vi } from "vitest";
import { createHostedRerankingProvider } from "@/server/providers/reranking/hosted";

afterEach(() => vi.unstubAllGlobals());

test("Cohere v2 adapter preserves authorized document ids", async () => {
  let requestBody: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
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
    ),
  );
  const provider = createHostedRerankingProvider({
    provider: "cohere",
    model: "rerank-v4.0-pro",
    apiKey: "cohere-secret",
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
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
        expect(String(input)).toBe("https://api.voyageai.com/v1/rerank");
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ data: [{ index: 0, relevance_score: 0.875 }] });
      },
    ),
  );
  const provider = createHostedRerankingProvider({
    provider: "voyage",
    model: "rerank-2.5",
    apiKey: "voyage-secret",
    instruction: "Prefer current user facts",
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
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
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
    ),
  );
  const provider = createHostedRerankingProvider({
    provider: "memos",
    model: "memos-reranker-0.6b",
    apiKey: "memos-secret",
    batchMaxCharacters: 18,
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
  vi.stubGlobal("fetch", async () =>
    Response.json({
      results: [
        { index: 0, relevance_score: 0.8 },
        { index: 0, relevance_score: 0.7 },
      ],
    }),
  );
  const provider = createHostedRerankingProvider({
    provider: "cohere",
    model: "rerank-v4.0-fast",
    apiKey: "secret",
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
  vi.stubGlobal("fetch", async () =>
    Response.json({ results: [{ index: 0, relevance_score: 1.25 }] }),
  );
  const provider = createHostedRerankingProvider({
    provider: "memos",
    model: "memos-reranker-0.6b",
    apiKey: "secret",
  });
  await expect(
    provider.rerank({
      query: "query",
      documents: [{ id: "first", text: "first" }],
      limit: 1,
    }),
  ).rejects.toThrow("invalid reranking result");
});

test.each(["cohere", "voyage"] as const)(
  "%s SDK sends one attempt and does not expose a provider error body",
  async (providerName) => {
    const fetch = vi.fn(async () =>
      Response.json({ message: "private evidence echoed by provider" }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);
    const provider = createHostedRerankingProvider({
      provider: providerName,
      model: "reranker",
      apiKey: "secret",
    });
    await expect(
      provider.rerank({
        query: "private question",
        documents: [{ id: "first", text: "private evidence" }],
        limit: 1,
      }),
    ).rejects.toThrow(new Error(`${providerName} reranking request failed with HTTP 503`));
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test.each(["cohere", "voyage"] as const)(
  "%s SDK results remain subject to Lore's score contract",
  async (providerName) => {
    for (const result of [
      { index: 0, relevance_score: 1.25 },
      { index: 1, relevance_score: 0.5 },
      { index: 0, relevance_score: "0.5" },
      { index: 0 },
    ]) {
      vi.stubGlobal("fetch", async () =>
        Response.json({ [providerName === "cohere" ? "results" : "data"]: [result] }),
      );
      const provider = createHostedRerankingProvider({
        provider: providerName,
        model: "reranker",
        apiKey: "secret",
      });
      await expect(
        provider.rerank({
          query: "query",
          documents: [{ id: "first", text: "first" }],
          limit: 1,
        }),
      ).rejects.toThrow("invalid reranking result");
    }
  },
);

test.each(["cohere", "voyage"] as const)(
  "%s SDK cancels a pending request at the configured deadline",
  async (providerName) => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const provider = createHostedRerankingProvider({
      provider: providerName,
      model: "reranker",
      apiKey: "secret",
      timeoutMs: 10,
    });
    await expect(
      provider.rerank({
        query: "query",
        documents: [{ id: "first", text: "first" }],
        limit: 1,
      }),
    ).rejects.toThrow(`${providerName} reranking request failed`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  },
);

test("Vercel AI Gateway reranking speaks the Cohere contract at the gateway host", async () => {
  let requestBody: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
        expect(String(input)).toBe("https://ai-gateway.vercel.sh/v2/rerank");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-secret");
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          results: [
            { index: 1, relevance_score: 0.91 },
            { index: 0, relevance_score: 0.12 },
          ],
        });
      },
    ),
  );
  const provider = createHostedRerankingProvider({
    provider: "vercel",
    model: "cohere/rerank-v3.5",
    apiKey: "gateway-secret",
  });

  expect(provider).toMatchObject({ provider: "vercel", revision: "lore-vercel-reranking-v1" });
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
    { documentId: "second", score: 0.91 },
    { documentId: "first", score: 0.12 },
  ]);
  expect(requestBody).toEqual({
    model: "cohere/rerank-v3.5",
    query: "Where did I study?",
    documents: ["I studied in Boston.", "I graduated from MIT."],
    top_n: 2,
  });
});

test("Vercel AI Gateway reranking requires a creator/model slug", () => {
  expect(() =>
    createHostedRerankingProvider({
      provider: "vercel",
      model: "rerank-v3.5",
      apiKey: "gateway-secret",
    }),
  ).toThrow("creator/model ids");
});
