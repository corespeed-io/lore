import { afterEach, expect, test, vi } from "vitest";
import { readGraphScalePrototype } from "@/modules/graph/browser/prototype";
import { clearRequestLog } from "@/shared/browser/request-log";

afterEach(() => {
  vi.unstubAllGlobals();
  clearRequestLog();
});

test("graph benchmark measures the original UTF-8 payload and forwards cancellation", async () => {
  const body = '{ "nodes": [], "links": [], "label": "中文" }\n';
  const fetchMock = vi.fn().mockResolvedValue(new Response(body));
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();

  const result = await readGraphScalePrototype(controller.signal);

  expect(result.data).toEqual(JSON.parse(body));
  expect(result.bytes).toBe(new TextEncoder().encode(body).byteLength);
  expect(result.milliseconds).toBeGreaterThanOrEqual(0);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/prototype/graph-scale",
    expect.objectContaining({ signal: controller.signal }),
  );
});
