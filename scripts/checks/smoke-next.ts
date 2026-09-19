import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

assert.ok(process.versions.bun, "Run this smoke test with Bun");
const root = new URL("../../", import.meta.url);
const standalone = new URL(".next/standalone/", root);
await cp(new URL("public/", root), new URL("public/", standalone), { recursive: true });
await cp(new URL(".next/static/", root), new URL(".next/static/", standalone), { recursive: true });

const reservation = createServer();
await new Promise<void>((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
assert.ok(address !== null && typeof address === "object", "Expected a TCP address");
const { port } = address;
await new Promise<void>((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("hex");
const authorization = `Basic ${Buffer.from(`smoke:${password}`).toString("base64")}`;
const child = spawn(process.execPath, ["--no-env-file", "server.js"], {
  cwd: fileURLToPath(standalone),
  // Explicit values also override any .env traced into the standalone output.
  env: {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
    AUTH_MODE: "password",
    UI_PASSWORD: password,
    ALLOW_INSECURE: "0",
    APP_TITLE: "Bun standalone smoke",
    DATABASE_URL: "postgres://smoke:smoke@127.0.0.1:1/lore_smoke",
    LORE_EMBEDDING_PROVIDER: "",
    LORE_RERANK_PROVIDER: "",
    LORE_QUERY_PLANNER_PROVIDER: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
let spawnError: Error | undefined;
let stopped = false;
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-12_000);
  });
}
const exited = new Promise<void>((resolve) => {
  child.once("error", (error) => {
    spawnError = error;
    stopped = true;
    resolve();
  });
  child.once("exit", () => {
    stopped = true;
    resolve();
  });
});

async function request(path: string, status: number, options: RequestInit = {}) {
  const response = await fetch(`${origin}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
    ...options,
  });
  assert.equal(response.status, status, `${options.method ?? "GET"} ${path}`);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=63072000; includeSubDomains; preload",
  );
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  return response;
}

try {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (spawnError) throw spawnError;
    assert.ok(!stopped, `Standalone server exited (${child.exitCode ?? child.signalCode})`);
    try {
      const response = await fetch(`${origin}/livez`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) break;
    } catch {
      // Retry connection failures while the production server starts.
    }
    assert.ok(Date.now() < deadline, "Standalone server did not become live within 30 seconds");
    await delay(100);
  }

  const live = await request("/livez", 200);
  assert.deepEqual(await live.json(), { status: "live" });
  assert.equal(live.headers.get("cache-control"), "no-store");
  assert.equal(await (await request("/livez", 200, { method: "HEAD" })).text(), "");
  const options = await request("/livez", 204, { method: "OPTIONS" });
  assert.match(options.headers.get("allow") ?? "", /\bGET\b/);
  await request("/livez", 405, { method: "POST" });

  const denied = await request("/api/memories", 401);
  const deniedBody: unknown = await denied.json();
  assert.ok(deniedBody !== null && typeof deniedBody === "object" && "code" in deniedBody);
  assert.equal(deniedBody.code, "authentication_required");
  // A page request carries no Hono admission of its own: only `src/middleware.ts`
  // rejects it. Assert that here, so moving or renaming that file can never
  // silently leave the UI unauthenticated.
  const unauthenticatedPage = await request("/", 401);
  assert.equal(unauthenticatedPage.headers.get("www-authenticate"), "Basic");
  assert.equal(
    ((await unauthenticatedPage.json()) as { code?: unknown }).code,
    "authentication_required",
  );
  const headers = { authorization };
  const missing = await request("/api/__standalone_smoke_missing", 404, { headers });
  assert.deepEqual(await missing.json(), { code: "not_found", error: "Not found" });
  await request("/", 200, { headers });
  await request("/memories/smoke", 200, { headers });
  const schema: unknown = await (await request("/openapi.json", 200, { headers })).json();
  assert.ok(
    schema !== null &&
      typeof schema === "object" &&
      "openapi" in schema &&
      typeof schema.openapi === "string" &&
      "paths" in schema &&
      schema.paths !== null &&
      typeof schema.paths === "object",
  );
  assert.match(schema.openapi, /^3\./);
  assert.ok("/api/v1/memories" in schema.paths);
  console.log(`Bun ${process.versions.bun}: Next standalone routing, auth, and Hono smoke passed`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (!stopped) {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKill.unref();
    child.kill("SIGTERM");
    await exited;
    clearTimeout(forceKill);
  }
}
