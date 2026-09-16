import {
  providerHttpError,
  readBoundedResponseJson,
  readBoundedResponseText,
} from "@corespeed/lore-core";
import { expect, test } from "vitest";

test("provider responses reject a declared body above the byte limit", async () => {
  const response = new Response("small", { headers: { "content-length": "100" } });
  await expect(readBoundedResponseText(response, 10)).rejects.toThrow(
    "Provider response exceeds 10 bytes",
  );
});

test("provider responses stop streaming once the byte limit is crossed", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
        controller.close();
      },
    }),
  );
  await expect(readBoundedResponseText(response, 8)).rejects.toThrow(
    "Provider response exceeds 8 bytes",
  );
});

test("provider JSON parsing stays bounded and rejects malformed payloads", async () => {
  await expect(
    readBoundedResponseJson<{ ok: boolean }>(Response.json({ ok: true }), 64),
  ).resolves.toEqual({ ok: true });
  await expect(readBoundedResponseJson(new Response("not-json"), 64)).rejects.toThrow(
    "Provider returned invalid JSON",
  );
});

test("provider HTTP errors consume their bounded response body before returning", async () => {
  const response = new Response("private provider detail", { status: 503 });
  await expect(providerHttpError(response, "provider failed")).resolves.toMatchObject({
    message: "provider failed",
  });
  expect(response.bodyUsed).toBe(true);
});
