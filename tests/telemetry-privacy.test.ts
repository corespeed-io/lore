import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";
import { privacySafeSpanName, scrubSpanForPrivacy } from "@/lib/telemetry-privacy";

test("telemetry removes query, content, tenant, resource, and provider details", () => {
  const span = {
    name: "GET /api/v1/memories/5f3739f8-4baa-4964-978e-c93c6c4eaca5?q=private+question",
    attributes: {
      "error.type": "ProviderError",
      "http.method": "GET",
      "http.target": "/api/v1/memories/id?q=private+question",
      "lore.operation": "memory.search",
      "memory.content": "secret",
      "next.route": "/api/v1/memories/5f3739f8-4baa-4964-978e-c93c6c4eaca5",
      "workspace.id": "tenant-secret",
    },
    status: { code: 2, message: "provider response included secret content" },
    events: [
      {
        name: "exception",
        time: [0, 0],
        attributes: { "exception.type": "ProviderError", "exception.message": "secret" },
        droppedAttributesCount: 0,
      },
    ],
    links: [
      {
        context: {},
        attributes: { "tenant.id": "tenant-secret" },
        droppedAttributesCount: 0,
      },
    ],
  } as unknown as ReadableSpan;

  scrubSpanForPrivacy(span);

  expect(span.name).toBe("GET /api/v1/memories/:id");
  expect(span.attributes).toEqual({
    "error.type": "ProviderError",
    "http.method": "GET",
    "lore.operation": "memory.search",
    "next.route": "/api/v1/memories/:id",
  });
  expect(span.status.message).toBeUndefined();
  expect(span.events[0]?.attributes).toEqual({ "exception.type": "ProviderError" });
  expect(span.links[0]?.attributes).toEqual({});
  expect(privacySafeSpanName("POST /api/v1/memories?content=secret")).toBe("POST /api/v1/memories");
});
