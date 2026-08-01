import { afterEach, expect, test, vi } from "vitest";

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

test("GET /api/graph maps a failed build to 502 and a healthy build to 200", async () => {
  const { clearGraphCache } = await import("../src/lib/graph.js");
  const { GET } = await import("../src/app/api/graph/route.js");
  const gbrain = await import("../src/lib/gbrain.js");
  const mocked = vi.mocked(gbrain.callTool);
  const base = mocked.getMockImplementation();
  if (!base) throw new Error("callTool mock missing");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  clearGraphCache();
  mocked.mockImplementation(async () => {
    throw new Error("gbrain down");
  });
  try {
    const bad = await GET();
    expect(bad.status).toBe(502);
    expect((await bad.json()).detail).toBe("couldn't reach the brain");
  } finally {
    mocked.mockImplementation(base);
    error.mockRestore();
    clearGraphCache();
  }
  const ok = await GET();
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.nodes).toEqual([]);
  expect(body.links).toEqual([]);
  clearGraphCache();
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

// The bearer-authed brain routes. Middleware exempts these from the viewer gate,
// so the bearer check inside each route is the ONLY thing standing in front of a
// write — /api/mcp has tests/brain-route.test.ts, these three had nothing.
const WRITE = "write-token-0123456789";
const READ = "read-token-01234567890";
const savedEnv = ["DATABASE_URL", "BRAIN_WRITE_TOKEN", "BRAIN_READ_TOKEN"].map(
  (k) => [k, process.env[k]] as const,
);

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

function armBrain() {
  // NOT `= undefined` — Node coerces that to the string "undefined" (truthy),
  // and the routes would try to open a database. Unconfigured is what makes a
  // 404 the proof that a request got PAST the bearer gate.
  Reflect.deleteProperty(process.env, "DATABASE_URL");
  process.env.BRAIN_WRITE_TOKEN = WRITE;
  process.env.BRAIN_READ_TOKEN = READ;
}

const bearer = (token?: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

test("POST /api/import fails closed and takes the write token only", async () => {
  armBrain();
  const { POST } = await import("../src/app/api/import/route.js");
  const post = (token?: string) =>
    POST(
      new Request("http://x/api/import", { method: "POST", headers: bearer(token), body: "{}" }),
    );

  const none = await post();
  expect(none.status).toBe(401);
  expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
  expect((await post("wrong-but-long-enough")).status).toBe(401);
  // Read is not enough: import writes.
  expect((await post(READ)).status).toBe(401);
  expect((await post(WRITE)).status).toBe(404);
});

test("POST /api/maintenance fails closed and takes the write token only", async () => {
  armBrain();
  const { POST } = await import("../src/app/api/maintenance/route.js");
  const post = (token?: string) =>
    POST(
      new Request("http://x/api/maintenance", {
        method: "POST",
        headers: bearer(token),
        body: "{}",
      }),
    );

  const none = await post();
  expect(none.status).toBe(401);
  expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
  expect((await post("wrong-but-long-enough")).status).toBe(401);
  // A read token must not be able to trigger a sweep — it writes auto edges.
  expect((await post(READ)).status).toBe(401);
  expect((await post(WRITE)).status).toBe(404);
});

test("GET /api/export fails closed but accepts either token", async () => {
  armBrain();
  const { GET } = await import("../src/app/api/export/route.js");
  const get = (token?: string) =>
    GET(new Request("http://x/api/export", { headers: bearer(token) }));

  const none = await get();
  expect(none.status).toBe(401);
  expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
  expect((await get("wrong-but-long-enough")).status).toBe(401);
  expect((await get(READ)).status).toBe(404);
  expect((await get(WRITE)).status).toBe(404);
});
