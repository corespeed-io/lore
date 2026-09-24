import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  createBenchmarkReaderFromEnvironment,
  LONGMEMEVAL_V2_READER_PROMPT_SHA256,
  longMemEvalV2ReaderInstruction,
  renderBenchmarkReaderInput,
  renderLongMemEvalV2ReaderInput,
} from "../../tools/evaluation/shared/benchmark-reader";

test("fixed-reader prompt preserves rank while enforcing a hard context budget", () => {
  const prompt = renderBenchmarkReaderInput(
    "Which module comes first?",
    [
      { id: "first", text: "Reports appears before Problems." },
      { id: "second", text: "x".repeat(2_000) },
    ],
    1_000,
  );

  expect(prompt).toContain('<evidence rank="1" id="first">');
  expect(prompt.indexOf('id="first"')).toBeLessThan(prompt.indexOf('id="second"'));
  expect(prompt.length).toBeLessThanOrEqual(1_000);
});

test("LongMemEval-V2 reader protocol keeps memory before the question and domain guidance", () => {
  const prompt = renderLongMemEvalV2ReaderInput(
    "What happened?",
    [{ id: "t-1", text: "The deployment was rolled back." }],
    1_000,
  );
  expect(prompt.indexOf("The deployment was rolled back.")).toBeLessThan(
    prompt.indexOf("What happened?"),
  );
  expect(prompt).toContain("### Memory context:");
  expect(prompt).toContain("### Question to answer:");
  expect(longMemEvalV2ReaderInstruction("enterprise")).toContain("customized ServiceNow");
  expect(createHash("sha256").update(longMemEvalV2ReaderInstruction("web")).digest("hex")).toBe(
    LONGMEMEVAL_V2_READER_PROMPT_SHA256.web,
  );
});

test("LongMemEval-V2 reader input separates trajectories and budgets the separator", () => {
  const header = "### Memory context:\n";
  const questionBlock = "\n\n### Question to answer:\nQ?";
  const evidence = [
    { id: "t-1", text: "  first trajectory ends here.  " },
    { id: "t-2", text: "## Trajectory 2\nsecond starts" },
  ];
  expect(renderLongMemEvalV2ReaderInput("Q?", evidence, 1_000)).toBe(
    `${header}first trajectory ends here.\n\n## Trajectory 2\nsecond starts${questionBlock}`,
  );

  // The separator consumes budget: two characters remain for the second trajectory.
  const fixed = header.length + questionBlock.length;
  const tight = [
    { id: "t-1", text: "aaaa" },
    { id: "t-2", text: "bbbb" },
  ];
  const truncated = renderLongMemEvalV2ReaderInput("Q?", tight, fixed + 4 + 2 + 2);
  expect(truncated).toBe(`${header}aaaa\n\nbb${questionBlock}`);
  expect(truncated.length).toBe(fixed + 8);
  // With no room beyond the separator, the second trajectory and its separator drop.
  expect(renderLongMemEvalV2ReaderInput("Q?", tight, fixed + 4 + 2)).toBe(
    `${header}aaaa${questionBlock}`,
  );
});

test("a self-hosted vLLM reader never borrows the OpenAI deployment key", async () => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null = "unset";
  const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
  try {
    const reader = createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "vllm",
      LORE_BENCHMARK_READER_MODEL: "Qwen/reader",
      LORE_BENCHMARK_READER_BASE_URL: "http://reader.test/v1",
      OPENAI_API_KEY: "sk-openai-deployment-key",
    });
    await reader?.answer({ question: "Q?", evidence: [{ id: "m", text: "fact" }] });
    expect(authorization).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a reader key is never sent to a plaintext endpoint outside loopback", () => {
  for (const [provider, key] of [
    ["vllm", "LORE_BENCHMARK_READER_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["google", "GEMINI_API_KEY"],
  ] as const) {
    expect(() =>
      createBenchmarkReaderFromEnvironment({
        LORE_BENCHMARK_READER_PROVIDER: provider,
        LORE_BENCHMARK_READER_MODEL: "reader-model",
        LORE_BENCHMARK_READER_BASE_URL: "http://reader.test/v1",
        [key]: "secret",
      }),
    ).toThrow("must use https outside loopback or host.docker.internal");
  }
  for (const baseUrl of ["http://127.0.0.1:8002/v1", "http://localhost:8002/v1"]) {
    expect(
      createBenchmarkReaderFromEnvironment({
        LORE_BENCHMARK_READER_PROVIDER: "vllm",
        LORE_BENCHMARK_READER_MODEL: "reader-model",
        LORE_BENCHMARK_READER_BASE_URL: baseUrl,
        LORE_BENCHMARK_READER_API_KEY: "secret",
      })?.provider,
    ).toBe("vllm");
  }
});

test("vLLM fixed reader sends multimodal deterministic chat input and records usage", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("http://reader.test/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "Qwen/reader", temperature: 0, max_tokens: 256 });
    expect(body.messages[1].content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Reports appears before Problems"),
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw==" },
      },
    ]);
    return Response.json({
      choices: [{ message: { content: "\\boxed{Reports;Problems}" } }],
      usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
    });
  };
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
  try {
    const reader = createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "vllm",
      LORE_BENCHMARK_READER_MODEL: "Qwen/reader",
      LORE_BENCHMARK_READER_BASE_URL: "http://reader.test/v1",
      LORE_BENCHMARK_READER_MAX_OUTPUT_TOKENS: "256",
    });
    await expect(
      reader?.answer({
        question: "Which modules?",
        questionImage: { data: "iVBORw==", mimeType: "image/png" },
        evidence: [{ id: "memory", text: "Reports appears before Problems" }],
      }),
    ).resolves.toEqual({
      text: "\\boxed{Reports;Problems}",
      inputTokens: 100,
      outputTokens: 8,
      totalTokens: 108,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google fixed reader disables storage and reads the final model-output step", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = _input instanceof Request ? _input : new Request(_input, init);
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const body = (await request.json()) as { input: unknown };
    expect(body).toMatchObject({ model: "gemini-reader", store: false, stream: false });
    expect(body.input).toEqual([
      { type: "text", text: expect.stringContaining("Option G") },
      { type: "image", mime_type: "image/png", data: "iVBORw==" },
    ]);
    return Response.json({
      id: "test-interaction",
      status: "completed",
      steps: [
        { type: "user_input", content: [] },
        { type: "model_output", content: [{ type: "text", text: "\\boxed{G}" }] },
      ],
      usage: { total_input_tokens: 80, total_output_tokens: 5, total_tokens: 85 },
    });
  };
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
  try {
    const reader = createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "google",
      LORE_BENCHMARK_READER_MODEL: "gemini-reader",
      GEMINI_API_KEY: "secret",
    });
    await expect(
      reader?.answer({
        question: "Choose",
        questionImage: { data: "iVBORw==", mimeType: "image/png" },
        evidence: [{ id: "memory", text: "Option G" }],
      }),
    ).resolves.toMatchObject({ text: "\\boxed{G}", totalTokens: 85 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama fixed reader bounds residency and records native accounting", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:12434/api/chat");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "qwen-reader:4b",
      stream: false,
      think: false,
      keep_alive: "5m",
      format: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
      options: {
        temperature: 0,
        seed: 42,
        top_p: 1,
        top_k: 1,
        num_ctx: 32768,
        num_predict: 256,
      },
      messages: [
        { role: "system" },
        {
          role: "user",
          content: expect.stringContaining("Reports appears before Problems"),
          images: ["iVBORw=="],
        },
      ],
    });
    return Response.json({
      message: { role: "assistant", content: "\\boxed{Reports;Problems}" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 90,
      eval_count: 7,
      total_duration: 1_000,
      load_duration: 100,
      prompt_eval_duration: 600,
      eval_duration: 300,
    });
  };
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
  try {
    const reader = createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "ollama",
      LORE_BENCHMARK_READER_MODEL: "qwen-reader:4b",
      LORE_BENCHMARK_READER_BASE_URL: "http://127.0.0.1:12434",
      LORE_BENCHMARK_READER_MAX_OUTPUT_TOKENS: "256",
    });
    expect(reader).toMatchObject({
      provider: "ollama",
      profile: "lore-portable-deterministic-v3",
      transport: "ollama-chat-v1",
      keepAlive: "5m",
      decoding: {
        temperature: 0,
        topP: 1,
        topK: 1,
        seed: 42,
        thinking: false,
        contextWindowTokens: 32768,
        maximumOutputTokens: 256,
      },
    });
    await expect(
      reader?.answer({
        question: "Which modules?",
        questionImage: { data: "iVBORw==", mimeType: "image/png" },
        evidence: [{ id: "memory", text: "Reports appears before Problems" }],
        responseSchema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "string" } },
        },
      }),
    ).resolves.toEqual({
      text: "\\boxed{Reports;Problems}",
      inputTokens: 90,
      outputTokens: 7,
      totalTokens: 97,
      finishReason: "stop",
      nativeTimingNanoseconds: {
        total: 1_000,
        load: 100,
        promptEvaluation: 600,
        evaluation: 300,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama reader pins a local model digest and unloads explicitly", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/api/version")) return Response.json({ version: "0.12.3" });
    if (url.endsWith("/api/tags")) {
      return Response.json({
        models: [
          {
            name: "qwen-reader:4b",
            model: "qwen-reader:4b",
            digest: "sha256:reader",
            modified_at: "2026-08-07T00:00:00Z",
            size: 2_000,
            details: {
              family: "qwen3",
              parameter_size: "4B",
              quantization_level: "Q4_K_M",
            },
          },
        ],
      });
    }
    if (url.endsWith("/api/show")) {
      return Response.json({
        template: "{{ .Prompt }}",
        parameters: "temperature 0",
        model_info: { "general.architecture": "qwen3" },
        capabilities: ["completion"],
      });
    }
    if (url.endsWith("/api/chat")) return Response.json({ done: true });
    return new Response(null, { status: 404 });
  };

  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
  const activeReader = createBenchmarkReaderFromEnvironment({
    LORE_BENCHMARK_READER_PROVIDER: "ollama",
    LORE_BENCHMARK_READER_MODEL: "qwen-reader:4b",
    LORE_BENCHMARK_READER_BASE_URL: "http://127.0.0.1:12434",
  });
  try {
    await expect(activeReader?.inspectRuntime?.()).resolves.toMatchObject({
      kind: "ollama-local",
      serverVersion: "0.12.3",
      model: {
        name: "qwen-reader:4b",
        digest: "sha256:reader",
        parameterSize: "4B",
        quantizationLevel: "Q4_K_M",
      },
      capabilities: ["completion"],
    });
    await activeReader?.close?.();
    expect(requests.at(-1)).toEqual({
      url: "http://127.0.0.1:12434/api/chat",
      body: { model: "qwen-reader:4b", messages: [], stream: false, keep_alive: 0 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama reader validates explicit keep-alive durations", () => {
  expect(() =>
    createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "ollama",
      LORE_BENCHMARK_READER_MODEL: "qwen-reader:4b",
      LORE_BENCHMARK_READER_KEEP_ALIVE: "forever",
    }),
  ).toThrow(/KEEP_ALIVE/);
  expect(() =>
    createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "ollama",
      LORE_BENCHMARK_READER_MODEL: "qwen-reader:4b",
      LORE_BENCHMARK_READER_KEEP_ALIVE: "-1",
    }),
  ).toThrow(/bounded/);
  expect(() =>
    createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "ollama",
      LORE_BENCHMARK_READER_MODEL: "qwen-reader:4b",
      LORE_BENCHMARK_READER_BASE_URL: "https://ollama.example.com",
    }),
  ).toThrow(/loopback/);
  expect(
    createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "ollama",
      LORE_BENCHMARK_READER_MODEL: "qwen-reader:4b",
      LORE_BENCHMARK_READER_THINKING: "1",
    })?.decoding.thinking,
  ).toBe(true);
  expect(() =>
    createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "ollama",
      LORE_BENCHMARK_READER_MODEL: "qwen-reader:4b",
      LORE_BENCHMARK_READER_THINKING: "sometimes",
    }),
  ).toThrow(/THINKING/);
});

test("Vercel AI Gateway fixed reader sends images through the gateway with its own key", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-gateway-key");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "openai/gpt-6-astra", temperature: 0, max_tokens: 512 });
    expect(body.store).toBeUndefined();
    expect(body.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw==" },
    });
    return Response.json({
      choices: [{ message: { content: "\\boxed{Reports}" } }],
      usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
    });
  };
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
  try {
    const reader = createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "vercel",
      LORE_BENCHMARK_READER_MODEL: "openai/gpt-6-astra",
      AI_GATEWAY_API_KEY: "test-gateway-key",
    });
    // Bumped with the trajectory separator, so new reports never read as v2 reports.
    expect(reader).toMatchObject({
      provider: "vercel",
      profile: "lore-portable-deterministic-v3",
      supportsQuestionImages: true,
    });
    await expect(
      reader?.answer({
        question: "Which module?",
        questionImage: { data: "iVBORw==", mimeType: "image/png" },
        evidence: [{ id: "memory", text: "Reports appears before Problems" }],
      }),
    ).resolves.toMatchObject({ text: "\\boxed{Reports}", totalTokens: 44 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Vercel AI Gateway fixed reader requires a gateway credential and a creator/model id", () => {
  expect(() =>
    createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "vercel",
      LORE_BENCHMARK_READER_MODEL: "openai/gpt-6-astra",
    }),
  ).toThrow("LORE_BENCHMARK_READER_API_KEY or AI_GATEWAY_API_KEY is required");
  expect(() =>
    createBenchmarkReaderFromEnvironment({
      LORE_BENCHMARK_READER_PROVIDER: "vercel",
      LORE_BENCHMARK_READER_MODEL: "gpt-6-astra",
      AI_GATEWAY_API_KEY: "test-gateway-key",
    }),
  ).toThrow("creator/model ids");
});
