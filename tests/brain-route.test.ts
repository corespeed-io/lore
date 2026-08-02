import { afterEach, expect, test } from "vitest";
import { GET, POST } from "../src/app/api/mcp/route.js";

const ENV_KEYS = ["DATABASE_URL", "BRAIN_WRITE_TOKEN", "BRAIN_READ_TOKEN"];
const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function post(body: unknown, token?: string): Promise<Response> {
  return POST(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

const WRITE = "write-token-0123456789";
const READ = "read-token-01234567890";

function arm() {
  process.env.DATABASE_URL = "postgres://unused/db";
  process.env.BRAIN_WRITE_TOKEN = WRITE;
  process.env.BRAIN_READ_TOKEN = READ;
}

test("404s when the standalone brain is not configured", async () => {
  // NOT `= undefined` — Node coerces that to the string "undefined" (truthy).
  Reflect.deleteProperty(process.env, "DATABASE_URL");
  const res = await post({ id: 1, method: "initialize" });
  expect(res.status).toBe(404);
});

test("fails closed: no token, wrong token, and short tokens are all rejected", async () => {
  arm();
  expect((await post({ id: 1, method: "initialize" })).status).toBe(401);
  expect((await post({ id: 1, method: "initialize" }, "wrong")).status).toBe(401);
  process.env.BRAIN_WRITE_TOKEN = "short";
  expect((await post({ id: 1, method: "initialize" }, "short")).status).toBe(401);
});

test("initialize answers over a valid bearer without touching the database", async () => {
  arm();
  const res = await post({ id: 7, method: "initialize", params: {} }, READ);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: number; result: { serverInfo: { name: string } } };
  expect(body.id).toBe(7);
  expect(body.result.serverInfo.name).toBe("lore-brain");
});

test("notifications get a 202 with no body", async () => {
  arm();
  const res = await post({ method: "notifications/initialized" }, WRITE);
  expect(res.status).toBe(202);
});

test("malformed bodies are 400, GET is 405", async () => {
  arm();
  const bad = await POST(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE}` },
      body: "not json",
    }),
  );
  expect(bad.status).toBe(400);
  expect(GET().status).toBe(405);
});
