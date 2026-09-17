import { afterEach, expect, test, vi } from "vitest";
import {
  CodeEvidenceAccessDeniedError,
  CodeEvidenceValidationError,
} from "@/modules/code/evidence";
import {
  CodeIndexAccessDeniedError,
  CodeIndexValidationError,
} from "@/modules/code/indexing/errors";
import { ContextRetrievalValidationError } from "@/modules/context/retrieval";
import { createMemoryModule } from "@/modules/memories/service";
import { createApi, isApiPath } from "@/server/api/app";
import { createAccessModule } from "@/server/auth/access";
import { loreOpenApiDocument } from "@/server/openapi/document";
import { createMemoryTestContext } from "../support/memory-context";

afterEach(() => vi.unstubAllEnvs());

test.each([
  [
    new CodeIndexValidationError("Invalid Code query"),
    400,
    "invalid_request",
    "Invalid Code query",
  ],
  [new CodeEvidenceValidationError("Invalid evidence"), 400, "invalid_request", "Invalid evidence"],
  [
    new ContextRetrievalValidationError("Invalid context"),
    400,
    "invalid_request",
    "Invalid context",
  ],
  [
    new CodeIndexAccessDeniedError("Code access denied"),
    403,
    "access_denied",
    "Code access denied",
  ],
  [
    new CodeEvidenceAccessDeniedError("Evidence access denied"),
    403,
    "access_denied",
    "Evidence access denied",
  ],
  [
    Object.assign(new Error("private SQL detail"), { code: "22P05" }),
    400,
    "invalid_request",
    "Input contains an invalid text value",
  ],
  [
    Object.assign(new Error("private upstream detail"), { status: 400, code: "invalid_request" }),
    500,
    "internal_error",
    "Internal server error",
  ],
] as const)(
  "Code and Context share safe error responses: %s",
  async (error, status, code, message) => {
    vi.stubEnv("AUTH_MODE", "none");
    vi.stubEnv("ALLOW_INSECURE", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createApi({
      database: () => {
        throw error;
      },
      memoryOptions: () => ({}),
      codeRepositories: () => ({}),
    });
    try {
      for (const [path, method] of [
        ["/api/v1/code/search", "GET"],
        ["/api/v1/context/retrieve", "POST"],
      ]) {
        const response = await app.request(path, { method });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ code, error: message });
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
    } finally {
      log.mockRestore();
    }
  },
);

function noDatabaseApi() {
  const database = vi.fn(() => {
    throw new Error("Database must not be initialized");
  });
  return {
    database,
    app: createApi({ database, memoryOptions: () => ({}), codeRepositories: () => ({}) }),
  };
}

test("liveness is independent of auth/database and API admission fails closed", async () => {
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("UI_PASSWORD", "test-password");
  const { app, database } = noDatabaseApi();
  for (const path of ["/livez", "/api/health"]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const path of ["/api/v1/memories", "/api/memories", "/openapi.json", "/livez/extra"]) {
    const response = await app.request(path);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Basic");
    expect(await response.json()).toMatchObject({ code: "authentication_required" });
  }
  expect(database).not.toHaveBeenCalled();
});

test("routing covers every OpenAPI operation and preserves HEAD, OPTIONS and 405", async () => {
  vi.stubEnv("ALLOW_INSECURE", "1");
  vi.stubEnv("AUTH_MODE", "none");
  const { app } = noDatabaseApi();
  const routes = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
  for (const [path, operations] of Object.entries(
    loreOpenApiDocument().paths as Record<string, Record<string, unknown>>,
  )) {
    for (const method of Object.keys(operations)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      expect(
        routes.has(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":id")}`),
        `${method} ${path}`,
      ).toBe(true);
    }
  }
  const head = await app.request("/livez", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  const options = await app.request("/api/v1/memories", { method: "OPTIONS" });
  expect(options.status).toBe(204);
  expect(options.headers.get("allow")).toContain("POST");
  expect(options.headers.get("content-type")).toBeNull();
  expect(await options.text()).toBe("");
  const unsupported = await app.request("/api/v1/memories", { method: "PUT" });
  expect(unsupported.status).toBe(405);
  expect(unsupported.headers.get("allow")).toContain("GET");
  expect((await app.request("/api/v1/unknown")).status).toBe(404);
  expect((await app.request("/api/prototype/graph-scale")).status).toBe(404);
  const document = await app.request("/openapi.json");
  expect(document.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(await document.json()).toEqual(loreOpenApiDocument());
  expect(isApiPath("/api")).toBe(true);
  expect(isApiPath("/api/v1/memories")).toBe(true);
  expect(isApiPath("/memories")).toBe(false);
  expect(isApiPath("/api-other")).toBe(false);
});

test("subrouter mounts keep versioned-only resources private to v1 and reject wrong methods", async () => {
  vi.stubEnv("ALLOW_INSECURE", "1");
  vi.stubEnv("AUTH_MODE", "none");
  const { app, database } = noDatabaseApi();
  for (const path of [
    "/api/actor",
    "/api/code/search",
    "/api/episodes",
    "/api/memories/example/code-evidence",
    "/api/workspaces/export",
    "/api/v1/v1/memories",
  ]) {
    const response = await app.request(path);
    expect(response.status, path).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  }
  for (const [path, method, allowed] of [
    ["/api/agents/example/credentials", "PATCH", ["GET", "HEAD", "POST", "OPTIONS"]],
    ["/api/v1/agents/example/credentials", "PATCH", ["GET", "HEAD", "POST", "OPTIONS"]],
    ["/api/v1/code-evidence/example/revalidate", "GET", ["POST", "OPTIONS"]],
    ["/api/v1/memories/example/code-evidence", "DELETE", ["GET", "HEAD", "POST", "OPTIONS"]],
    ["/livez", "POST", ["GET", "HEAD", "OPTIONS"]],
  ] as const) {
    const response = await app.request(path, { method });
    expect(response.status, `${method} ${path}`).toBe(405);
    expect(response.headers.get("allow")?.split(", ").sort()).toEqual([...allowed].sort());
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "method_not_allowed" });
  }
  expect(database).not.toHaveBeenCalled();
});

test("Hono preserves Memory aliases, authorization, ETags, replay and dynamic IDs", async () => {
  vi.stubEnv("AUTH_MODE", "none");
  vi.stubEnv("ALLOW_INSECURE", "1");
  vi.stubEnv("LORE_LOCAL_SUBJECT", "hono-user");
  const context = await createMemoryTestContext();
  const app = createApi({
    database: () => context.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  try {
    const workspaceResponse = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Hono Lab" }),
    });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const headers = { "content-type": "application/json", "x-lore-workspace-id": workspace.id };
    const create = () =>
      app.request("/api/v1/memories", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "hono-replay" },
        body: JSON.stringify({ content: "Shared Hono request contract.", scope: "private" }),
      });
    const createdResponse = await create();
    expect(createdResponse.status).toBe(201);
    const memory = (await createdResponse.json()) as { id: string };
    expect(((await (await create()).json()) as { id: string }).id).toBe(memory.id);
    const detail = await app.request(`/api/memories/${memory.id}`, { headers });
    expect(detail.status).toBe(200);
    expect(detail.headers.get("etag")).toBe('"memory-v1"');
    const patched = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ content: "Updated through the versioned route." }),
    });
    expect(patched.status).toBe(200);
    expect(patched.headers.get("etag")).toBe('"memory-v2"');
    const stale = await app.request(`/api/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ content: "Stale" }),
    });
    expect(stale.status).toBe(412);
    const missingWorkspace = await app.request("/api/v1/memories");
    expect(missingWorkspace.status).toBe(403);
    const wrongWorkspace = await app.request(`/api/v1/memories/${memory.id}`, {
      headers: { ...headers, "x-lore-workspace-id": context.carol.workspaceId },
    });
    expect(wrongWorkspace.status).toBe(403);
    const forgedAgent = await app.request("/api/v1/memories", {
      headers: { ...headers, authorization: `Bearer lore_agent_${"0".repeat(64)}` },
    });
    expect(forgedAgent.status).toBe(403);
    const deleted = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "DELETE",
      headers: { ...headers, "if-match": '"memory-v2"' },
    });
    expect(deleted.status).toBe(204);
    expect((await app.request(`/api/memories/${memory.id}`, { headers })).status).toBe(404);
  } finally {
    await context.close();
  }
});

test("concurrent requests reuse their own database adapter without sharing Actor context", async () => {
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("UI_PASSWORD", "test-password");
  const context = await createMemoryTestContext();
  const access = createAccessModule(context.database);
  const memories = createMemoryModule(context.database);
  const fixtures = [];
  for (const actor of [context.alice, context.carol]) {
    const agent = await access.createAgentForWorkspace(actor, {
      name: "Request isolation",
      permission: "read",
    });
    const credential = await access.issueAgentCredential(actor, agent.id);
    const memory = await memories.remember(actor, {
      content: `Private Memory for ${actor.userId}`,
      scope: "private",
    });
    fixtures.push({ actor, agent, credential, memory });
  }
  const database = vi.fn(async () => ({ transaction: context.database.transaction }));
  const app = createApi({ database, memoryOptions: () => ({}), codeRepositories: () => ({}) });
  const responses = await Promise.all(
    fixtures.map(({ actor, credential }) =>
      app.request("/api/v1/memories", {
        headers: {
          authorization: `Bearer ${credential.token}`,
          "x-lore-workspace-id": actor.workspaceId,
        },
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ id: fixtures[index].memory.id }),
    ]);
  }
  // The service and Actor resolver use the same adapter, with one fresh adapter per request.
  expect(database).toHaveBeenCalledTimes(2);

  const { actor, agent, credential } = fixtures[0];
  await access.revokeAgentGrant(actor, agent.id);
  const revoked = await app.request("/api/v1/memories", {
    headers: {
      authorization: `Bearer ${credential.token}`,
      "x-lore-workspace-id": actor.workspaceId,
    },
  });
  expect(revoked.status).toBe(403);
  expect(database).toHaveBeenCalledTimes(3);
});
