import {
  LoreApiError,
  LoreClient,
  loreConfigurationFromEnvironment,
  type Memory,
} from "@corespeed/lore-sdk";
import { describe, expect, test, vi } from "vitest";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const MEMORY_ID = "20000000-0000-4000-8000-000000000001";
const AGENT_TOKEN = `lore_agent_${"a".repeat(64)}`;

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: MEMORY_ID,
    workspaceId: WORKSPACE_ID,
    ownerUserId: "30000000-0000-4000-8000-000000000001",
    createdByAgentId: null,
    scope: "shared",
    content: "Lore remembers safely.",
    metadata: {},
    version: 3,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("Lore TypeScript SDK", () => {
  test("uses stable v1 routes with Actor authentication and Workspace context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([memory()], {
        headers: { "x-lore-next-cursor": "next-page" },
      }),
    );
    const client = new LoreClient({
      baseUrl: "https://lore.example.test/base/",
      auth: { type: "agent", token: AGENT_TOKEN },
      fetch: fetchMock,
    });

    const page = await client.workspace(WORKSPACE_ID).listMemories({ limit: 25 });

    expect(page).toEqual({ memories: [memory()], nextCursor: "next-page" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://lore.example.test/base/api/v1/memories?limit=25");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(headers.get("x-lore-workspace-id")).toBe(WORKSPACE_ID);
    expect(init.redirect).toBe("error");
  });

  test("sends strong version and replay protection on mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(memory({ version: 4 })));
    const workspace = new LoreClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: fetchMock,
    }).workspace(WORKSPACE_ID);

    await workspace.updateMemory(
      MEMORY_ID,
      { content: "Updated" },
      { expectedVersion: 3, idempotencyKey: "update-1" },
    );

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/api/v1/memories/${MEMORY_ID}`);
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers)).toMatchObject({});
    const headers = new Headers(init.headers);
    expect(headers.get("if-match")).toBe('"memory-v3"');
    expect(headers.get("idempotency-key")).toBe("update-1");
    expect(init.body).toBe(JSON.stringify({ content: "Updated" }));
  });

  test("refuses authenticated plain HTTP outside loopback unless explicitly allowed", () => {
    expect(
      () =>
        new LoreClient({
          baseUrl: "http://lore.example.test",
          auth: { type: "agent", token: AGENT_TOKEN },
        }),
    ).toThrow(/requires HTTPS/);

    expect(
      () =>
        new LoreClient({
          baseUrl: "http://lore.example.test",
          auth: { type: "agent", token: AGENT_TOKEN },
          allowInsecure: true,
        }),
    ).not.toThrow();
  });

  test("does not allow custom headers to bypass authentication transport policy", () => {
    expect(
      () =>
        new LoreClient({
          baseUrl: "https://lore.example.test",
          headers: { authorization: "Bearer bypass" },
        }),
    ).toThrow(/typed Lore client options/);
    expect(
      () =>
        new LoreClient({
          baseUrl: "http://lore.example.test",
          headers: { "x-trusted-proxy": "signed" },
        }),
    ).toThrow(/requires HTTPS/);
  });

  test("uses Cloudflare client and service-token headers instead of the origin assertion", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json([]));
    const accessClient = new LoreClient({
      baseUrl: "https://lore.example.test",
      gateway: { type: "cloudflare-access-token", token: "access-jwt" },
      fetch: fetchMock,
    });
    await accessClient.listWorkspaces();
    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    if (!firstRequest) throw new Error("Expected Access client request");
    let headers = new Headers(firstRequest.headers);
    expect(headers.get("cf-access-token")).toBe("access-jwt");
    expect(headers.get("cf-access-jwt-assertion")).toBeNull();

    const serviceClient = new LoreClient({
      baseUrl: "https://lore.example.test",
      auth: { type: "agent", token: AGENT_TOKEN },
      gateway: {
        type: "cloudflare-service-token",
        clientId: "client-id.access",
        clientSecret: "client-secret",
      },
      fetch: fetchMock,
    });
    await serviceClient.listWorkspaces();
    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    if (!secondRequest) throw new Error("Expected Access service request");
    headers = new Headers(secondRequest.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(headers.get("cf-access-client-id")).toBe("client-id.access");
    expect(headers.get("cf-access-client-secret")).toBe("client-secret");
  });

  test("returns structured API failures without exposing credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "access_denied", error: "Workspace access denied" }, { status: 403 }),
      );
    const client = new LoreClient({
      baseUrl: "https://lore.example.test",
      auth: { type: "agent", token: AGENT_TOKEN },
      fetch: fetchMock,
    });

    const failure = await client
      .workspace(WORKSPACE_ID)
      .getMemory(MEMORY_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoreApiError);
    expect(failure).toMatchObject({ status: 403, code: "access_denied" });
    expect(String(failure)).not.toContain(AGENT_TOKEN);
  });

  test("normalizes fetch failures without reflecting transport details", async () => {
    const client = new LoreClient({
      baseUrl: "https://lore.example.test",
      auth: { type: "agent", token: AGENT_TOKEN },
      fetch: vi.fn().mockRejectedValue(new TypeError(`DNS failure for ${AGENT_TOKEN}`)),
    });

    const failure = await client.listWorkspaces().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoreApiError);
    expect(failure).toMatchObject({ status: 0, code: "transport_error" });
    expect(String(failure)).not.toContain(AGENT_TOKEN);
  });

  test("times out stalled requests without requiring an MCP caller signal", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        async (_url: URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const client = new LoreClient({
        baseUrl: "http://127.0.0.1:3000",
        fetch: fetchMock,
      });
      const pending = client.listWorkspaces();
      const failure = expect(pending).rejects.toMatchObject({
        status: 0,
        code: "transport_error",
        message: "Lore request timed out",
      });
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(request?.signal).toBeInstanceOf(AbortSignal);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(request?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await failure;
      expect(request?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("preserves explicit caller cancellation", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new LoreClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: fetchMock,
    });
    const controller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const pending = client.listWorkspaces(controller.signal);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  test("cancels a declared oversize error body before reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 500,
      headers: { "content-length": String(64 * 1024 + 1) },
    });
    const client = new LoreClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: vi.fn().mockResolvedValue(response),
    });

    await expect(client.listWorkspaces()).rejects.toMatchObject({ code: "invalid_response" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("bounds streamed error bodies without a Content-Length header", async () => {
    const client = new LoreClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: vi
        .fn()
        .mockResolvedValue(new Response(new Uint8Array(64 * 1024 + 1), { status: 500 })),
    });

    await expect(client.listWorkspaces()).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("rejects malformed UTF-8 instead of changing returned content", async () => {
    const prefix = new TextEncoder().encode('[{"name":"');
    const suffix = new TextEncoder().encode('"}]');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix);
    body[prefix.length] = 0xff;
    body.set(suffix, prefix.length + 1);
    const client = new LoreClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: vi.fn().mockResolvedValue(new Response(body)),
    });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "invalid_response",
      message: "Lore returned invalid UTF-8",
    });
  });

  test("returns the typed unready report carried by readiness HTTP 503", async () => {
    const report = {
      status: "unready" as const,
      components: {
        database: "unavailable" as const,
        embedding: "unknown" as const,
        rlsRole: "unavailable" as const,
        schema: "unavailable" as const,
        vector: "unavailable" as const,
      },
    };
    const client = new LoreClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: vi.fn().mockResolvedValue(Response.json(report, { status: 503 })),
    });

    await expect(client.readiness()).resolves.toEqual(report);
  });

  test("rejects ambiguous environment authentication", () => {
    expect(() =>
      loreConfigurationFromEnvironment({
        LORE_AGENT_TOKEN: AGENT_TOKEN,
        LORE_BASIC_PASSWORD: "secret",
      }),
    ).toThrow(/only one/);
  });

  test("layers Cloudflare service credentials over Lore Agent authentication", () => {
    const configuration = loreConfigurationFromEnvironment({
      LORE_AGENT_TOKEN: AGENT_TOKEN,
      LORE_ACCESS_CLIENT_ID: "client-id.access",
      LORE_ACCESS_CLIENT_SECRET: "client-secret",
      LORE_REQUEST_TIMEOUT_MS: "120000",
    });

    expect(configuration.client).toMatchObject({
      auth: { type: "agent", token: AGENT_TOKEN },
      gateway: {
        type: "cloudflare-service-token",
        clientId: "client-id.access",
        clientSecret: "client-secret",
      },
      timeoutMs: 120_000,
    });
  });

  test("rejects an invalid environment request timeout", () => {
    for (const timeout of ["0", "300001", "1.5", "never"]) {
      expect(() => loreConfigurationFromEnvironment({ LORE_REQUEST_TIMEOUT_MS: timeout })).toThrow(
        /LORE_REQUEST_TIMEOUT_MS|timeoutMs/,
      );
    }
  });
});
