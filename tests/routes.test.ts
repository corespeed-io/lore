import { expect, test, vi } from "vitest";

vi.mock("../src/lib/gbrain.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/gbrain.js")>();
  return {
    ...real,
    callTool: vi.fn(async (tool: string) => {
      if (!real.READ_ONLY_TOOLS.has(tool)) throw new real.ToolNotAllowedError("nope");
      return { isError: false, text: "[]" };
    }),
  };
});

test("POST /api/call rejects a write tool with 403", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(
    new Request("http://x/api/call", {
      method: "POST",
      body: JSON.stringify({ tool: "put_page", args: {} }),
    }),
  );
  expect(res.status).toBe(403);
});

test("POST /api/call passes a read tool", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(
    new Request("http://x/api/call", {
      method: "POST",
      body: JSON.stringify({ tool: "list_pages", args: {} }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ isError: false, text: "[]" });
});

test("GET /api/health is ok", async () => {
  const { GET } = await import("../src/app/api/health/route.js");
  const res = await GET();
  expect((await res.json()).status).toBe("ok");
});

test("POST /api/call clamps an oversized limit before reaching gbrain", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const gbrain = await import("../src/lib/gbrain.js");
  await POST(
    new Request("http://x/api/call", {
      method: "POST",
      body: JSON.stringify({ tool: "list_pages", args: { limit: 1_000_000 } }),
    }),
  );
  // MAX is 200 — hand-known from the route, not computed by the code under test.
  // biome-ignore lint/suspicious/noExplicitAny: reaching into the vi mock
  const lastArgs = (gbrain.callTool as any).mock.calls.at(-1)[1];
  expect(lastArgs.limit).toBe(200);
});

test("POST /api/call rejects a missing/non-string tool with 400", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(
    new Request("http://x/api/call", { method: "POST", body: JSON.stringify({ args: {} }) }),
  );
  expect(res.status).toBe(400);
});

test("POST /api/call rejects an unparseable body with 400", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(new Request("http://x/api/call", { method: "POST", body: "not json" }));
  expect(res.status).toBe(400);
});
