import { spawn } from "node:child_process";
// The CLI is the server's own conformance client — AGENTS.md says so — and until
// this file existed nothing ran it, so the claim was decoration. These tests
// spawn the real script against a stub HTTP server: no mocks of its internals,
// because the two things that have already broken here (an exit code, a missing
// guard) are only visible from outside the process.
import { type Server, createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = fileURLToPath(new URL("../bin/lore.mjs", import.meta.url));

interface Seen {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
// What the next request should get back, so one stub covers refusals too.
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, LORE_URL: base, LORE_TOKEN: "test-token-0123456789" },
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      err += c;
    });
    p.on("close", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

const envelope = (payload: unknown, isError = false) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError,
  },
});

test("a tool result is unwrapped from the envelope, not printed as one", async () => {
  seen.length = 0;
  reply = { status: 200, body: envelope([{ slug: "a" }]) };
  const { code, out } = await run(["search", "hello"]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual([{ slug: "a" }]);
});

// The header is REQUIRED of a modern client, and the server refuses one that
// disagrees with the body — so a drift between the two spellings would take the
// CLI off the air against its own server.
test("every request carries the modern headers, matching the body", async () => {
  seen.length = 0;
  reply = { status: 200, body: envelope({ slug: "x" }) };
  await run(["get", "some-slug"]);
  const req = seen.at(-1);
  expect(req?.path).toBe("/api/mcp");
  expect(req?.headers["mcp-method"]).toBe("tools/call");
  expect(req?.headers["mcp-name"]).toBe("get_page");
  const params = (req?.body as { params: Record<string, unknown> }).params;
  expect(req?.headers["mcp-protocol-version"]).toBe(
    (params._meta as Record<string, string>)["io.modelcontextprotocol/protocolVersion"],
  );
});

// isError is a FIELD on a 200 response. Printing it and exiting 0 reports a
// refusal as a success — the whole reason this file exists.
test("isError exits non-zero and writes to stderr", async () => {
  reply = { status: 200, body: envelope("not_found: nope", true) };
  const { code, out, err } = await run(["get", "nope"]);
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toMatch(/not_found/);
});

test("a JSON-RPC error exits non-zero and reports its data", async () => {
  reply = {
    status: 400,
    body: {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: ["2026-07-28"], requested: "1900-01-01" },
      },
    },
  };
  const { code, err } = await run(["ls"]);
  expect(code).toBe(1);
  expect(err).toMatch(/Unsupported protocol version/);
});

// The regression this test was written for: `sweep` used to call fetch directly,
// skipping the token/401/status guards, and exited 0 on a refusal.
test("sweep goes through the same door and fails loudly", async () => {
  seen.length = 0;
  reply = { status: 403, body: { detail: "write token required" } };
  const { code, out, err } = await run(["sweep", "--dry"]);
  expect(seen.at(-1)?.path).toBe("/api/maintenance");
  expect(seen.at(-1)?.body).toEqual({ dryRun: true });
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toMatch(/403/);
});

test("401 is named as an auth failure rather than a parse failure", async () => {
  reply = { status: 401, body: { detail: "auth required" } };
  const { code, err } = await run(["ls"]);
  expect(code).toBe(1);
  expect(err).toMatch(/unauthorized/);
});

test("malformed JSON arguments are refused before any request is made", async () => {
  seen.length = 0;
  const { code, err } = await run(["call", "search", "{oops}"]);
  expect(code).toBe(1);
  expect(err).toMatch(/must be JSON/);
  expect(seen).toHaveLength(0);
});

test("an unknown command prints help and exits 2", async () => {
  const { code, out } = await run(["wat"]);
  expect(code).toBe(2);
  expect(out).toMatch(/lore search/);
});
