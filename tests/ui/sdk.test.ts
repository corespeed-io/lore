import { LoreApiError, LoreClient } from "@corespeed/lore-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { forgetMemory, rememberMemory, updateMemory } from "@/modules/memories/client";
import { clearRequestLog, getRequestLog } from "@/shared/browser/request-log";
import { getBrowserClient } from "@/shared/browser/sdk";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const memoryId = "20000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.stubGlobal("window", { location: { origin: "https://lore.test" } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearRequestLog();
});

test("a browser write can complete after the SDK's ordinary deadline", async () => {
  vi.useFakeTimers();
  let complete!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        complete = resolve;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const saved = { id: memoryId, version: 1 };
  const pending = rememberMemory(workspaceId, { content: "Fact", scope: "shared" });
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  await vi.advanceTimersByTimeAsync(600_000);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  expect(getRequestLog()).toEqual([]);
  complete(Response.json(saved));

  await expect(outcome).resolves.toEqual({ value: saved });
  expect(getRequestLog()).toMatchObject([{ operation: "POST /api/v1/memories", ok: true }]);
});

test("a browser caller can still cancel a request after a long wait", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const reason = new DOMException("caller cancelled", "AbortError");
  const pending = getBrowserClient().listWorkspaces(controller.signal);
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  await vi.advanceTimersByTimeAsync(600_000);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  controller.abort(reason);

  await expect(outcome).resolves.toEqual({ error: reason });
  expect(getRequestLog()).toEqual([]);
});

test("invalid JSON is recorded as a failure after consuming the body", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Not JSON</html>")));

  await expect(getBrowserClient().listWorkspaces()).rejects.toBeInstanceOf(LoreApiError);
  expect(getRequestLog()).toMatchObject([{ operation: "GET /api/v1/workspaces", ok: false }]);
});

test("cancellation while consuming the body leaves no request log entry", async () => {
  const aborted = new DOMException("Cancelled", "AbortError");
  const body = new ReadableStream({
    start(controller) {
      controller.error(aborted);
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));

  await expect(getBrowserClient().listWorkspaces()).rejects.toBe(aborted);
  expect(getRequestLog()).toEqual([]);
});

test("browser errors retain SDK status and code, with identifiers omitted from operation labels", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "Memory does not exist", code: "not_found" }, { status: 404 }),
      ),
  );

  await expect(getBrowserClient().workspace(workspaceId).getMemory(memoryId)).rejects.toMatchObject(
    {
      status: 404,
      code: "not_found",
    },
  );
  expect(getRequestLog()).toMatchObject([
    { operation: "GET /api/v1/memories/:id", ok: false, error: "Memory does not exist" },
  ]);
});

test("search terms and metadata filters do not enter request operation labels", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
  await getBrowserClient()
    .workspace(workspaceId)
    .searchMemories({
      query: "private search terms",
      metadata: { token: "private filter" },
    });
  expect(getRequestLog()).toMatchObject([{ operation: "GET /api/v1/memories", ok: true }]);
  expect(JSON.stringify(getRequestLog())).not.toContain("private");
});

test("browser writes reuse SDK concurrency and replay headers", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: memoryId, version: 1 }))
    .mockResolvedValueOnce(Response.json({ id: memoryId, version: 2 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);

  await rememberMemory(workspaceId, { content: "Fact", scope: "shared" });
  await updateMemory(workspaceId, memoryId, { content: "Updated fact" }, 1);
  await forgetMemory(workspaceId, memoryId, 2);

  const headers = fetcher.mock.calls.map(
    ([, input]) => new Headers((input as RequestInit).headers),
  );
  expect(headers.map((header) => header.get("x-lore-workspace-id"))).toEqual([
    workspaceId,
    workspaceId,
    workspaceId,
  ]);
  expect(headers.map((header) => header.get("if-match"))).toEqual([
    null,
    '"memory-v1"',
    '"memory-v2"',
  ]);
  for (const header of headers) expect(header.get("idempotency-key")).toMatch(/^[\da-f-]{36}$/);
  expect(new Set(headers.map((header) => header.get("idempotency-key"))).size).toBe(3);
  expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/api/v1/memories",
    `/api/v1/memories/${memoryId}`,
    `/api/v1/memories/${memoryId}`,
  ]);
  expect(getRequestLog().map(({ ok }) => ok)).toEqual([true, true, true]);
});

test("observability exceptions cannot change a successful SDK result", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
  const client = new LoreClient({
    baseUrl: "https://lore.test",
    onRequest() {
      throw new Error("listener failed");
    },
  });
  await expect(client.listWorkspaces()).resolves.toEqual([]);
});
