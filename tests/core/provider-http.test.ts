import { MAX_PROVIDER_JSON_RESPONSE_BYTES } from "@corespeed/lore-core";
import { expect, test, vi } from "vitest";
import { requestProviderJson } from "../../packages/lore-core/src/provider-http";

test("provider transport preserves request options and bounds successful JSON bodies", async () => {
  const signal = AbortSignal.timeout(1000);
  const response = new Response("{}", {
    headers: { "content-length": String(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1) },
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
