import { type Context, Hono } from "hono";
import { methodNotAllowed } from "hono/method-not-allowed";
import { agentCredentials, agents } from "@/modules/agents/routes";
import { code, codeEvidence, memoryCodeEvidence } from "@/modules/code/routes";
import { context } from "@/modules/context/routes";
import { episodes, observations } from "@/modules/episodes/routes";
import { evaluations } from "@/modules/evaluations/routes";
import { graph } from "@/modules/graph/routes";
import { actor } from "@/modules/identity/routes";
import { memories } from "@/modules/memories/routes";
import { capabilities, operations } from "@/modules/operations/routes";
import { portability } from "@/modules/portability/routes";
import { proposals } from "@/modules/proposals/routes";
import { workspaces } from "@/modules/workspaces/routes";
import { errorResponse } from "@/server/api/errors";
import { authorizeRequest } from "@/server/auth/auth";
import { securityHeaders } from "@/server/security-headers";
import { type ApiDependencies, type ApiEnv, createRequestDependencies } from "./dependencies";

/** One routing table for Next.js and workerd. Hosts own database/provider lifetimes. */
export function createApi(dependencies: ApiDependencies) {
  const app = new Hono<ApiEnv>();
  app.onError(errorResponse);
  app.notFound((c) => c.json({ code: "not_found", error: "Not found" }, 404));
  const headers = securityHeaders();
  app.use(async (c, next) => {
    await next();
    for (const { key, value } of headers) c.header(key, value);
  });
  app.use(async (c, next) => {
    const request = createRequestDependencies(dependencies, c.req.raw);
    c.set("database", request.database);
    c.set("memoryOptions", request.memoryOptions);
    c.set("codeRepositories", request.codeRepositories);
    c.set("resolveActor", request.resolveActor);
    c.set("resolveUser", request.resolveUser);
    const denied = await authorizeRequest(c.req.raw);
    if (denied) c.res = denied;
    else await next();
    if (!c.res.headers.has("cache-control")) c.header("Cache-Control", "private, no-store");
  });
  app.use(methodNotAllowed({ app, onMethodNotAllowed: respondToUnsupportedMethod }));
  // These resources share the same handlers at both public prefixes.
  const shared = new Hono<ApiEnv>()
    .route("/agent-credentials", agentCredentials)
    .route("/agents", agents)
    .route("/capabilities", capabilities)
    .route("/evaluations", evaluations)
    .route("/graph", graph)
    .route("/memories", memories)
    .route("/workspaces", workspaces);

  const v1 = new Hono<ApiEnv>()
    .route("/", shared)
    .route("/actor", actor)
    .route("/code", code)
    .route("/code-evidence", codeEvidence)
    .route("/context", context)
    .route("/episodes", episodes)
    .route("/observations", observations)
    .route("/memories", memoryCodeEvidence)
    .route("/memory-proposals", proposals)
    .route("/workspaces", portability);

  return app.route("/", operations).route("/api", shared).route("/api/v1", v1);
}

function respondToUnsupportedMethod(c: Context<ApiEnv>, methods: string[]): Response {
  c.header("Allow", [...methods, "OPTIONS"].join(", "));
  if (c.req.method === "OPTIONS") {
    c.header("Content-Type", undefined);
    return c.body(null, 204);
  }
  return c.json({ code: "method_not_allowed", error: "Method not allowed" }, 405);
}

export function isApiPath(path: string): boolean {
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/livez" ||
    path === "/readyz" ||
    path === "/openapi.json"
  );
}
