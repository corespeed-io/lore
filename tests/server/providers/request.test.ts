import { expect, test, vi } from "vitest";
import { requestProviderJson } from "@/server/providers/request";

test("provider transport preserves request options and bounds successful JSON bodies", async () => {
  const signal = AbortSignal.timeout(1000);
  const response = new Response("{}", {
    headers: { "content-length": String(8 * 1024 * 1024 + 1) },
  });
  const fetch = vi.fn().mockResolvedValue(response);
  await expect(
    requestProviderJson("https://provider.test/model", {
      fetch,
      method: "POST",
      body: "payload",
      headers: { authorization: "Bearer test" },
      signal,
      errorMessage: (status) => `Failed ${status}`,
    }),
  ).rejects.toThrow("Provider response exceeds");
  expect(fetch).toHaveBeenCalledWith("https://provider.test/model", {
    method: "POST",
    body: "payload",
    headers: { authorization: "Bearer test" },
    signal,
  });
  expect(response.bodyUsed).toBe(true);
});

test("provider transport consumes error bodies without leaking them or retrying", async () => {
  const response = new Response("sensitive upstream body", { status: 429 });
  const fetch = vi.fn().mockResolvedValue(response);
  await expect(
    requestProviderJson("https://provider.test/model", {
      fetch,
      errorMessage: (status) => `Provider failed (${status})`,
    }),
  ).rejects.toThrow("Provider failed (429)");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(response.bodyUsed).toBe(true);
});

test("provider transport preserves network cancellation without retrying", async () => {
  const abort = new DOMException("cancelled", "AbortError");
  const fetch = vi.fn().mockRejectedValue(abort);
  await expect(
    requestProviderJson("https://provider.test/model", {
      fetch,
      errorMessage: (status) => `Failed ${status}`,
    }),
  ).rejects.toBe(abort);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("provider transport cancels a stream that exceeds the JSON body limit", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    }),
  );
  await expect(
    requestProviderJson("https://provider.test/model", {
      fetch: vi.fn().mockResolvedValue(response),
      errorMessage: (status) => `Provider failed (${status})`,
    }),
  ).rejects.toThrow("Provider response exceeds 8388608 bytes");
  expect(cancel).toHaveBeenCalledOnce();
});

test("provider transport parses successful JSON bodies", async () => {
  await expect(
    requestProviderJson("https://provider.test/model", {
      fetch: vi.fn().mockResolvedValue(Response.json({ ok: true })),
      errorMessage: (status) => `Provider failed (${status})`,
    }),
  ).resolves.toEqual({ ok: true });
});

test("provider transport rejects malformed JSON bodies", async () => {
  await expect(
    requestProviderJson("https://provider.test/model", {
      fetch: vi.fn().mockResolvedValue(new Response("not-json")),
      errorMessage: (status) => `Provider failed (${status})`,
    }),
  ).rejects.toThrow("Provider returned invalid JSON");
});

test("provider transport limits error bodies while preserving the safe status message", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
      },
      cancel,
    }),
    { status: 503 },
  );
  await expect(
    requestProviderJson("https://provider.test/model", {
      fetch: vi.fn().mockResolvedValue(response),
      errorMessage: (status) => `Provider failed (${status})`,
    }),
  ).rejects.toThrow("Provider failed (503)");
  expect(cancel).toHaveBeenCalledOnce();
});
