import { agentsPaths, agentsSchemas } from "@/modules/agents/openapi";
import { codePaths, codeSchemas } from "@/modules/code/openapi";
import { contextPaths, contextSchemas } from "@/modules/context/openapi";
import { episodesPaths, episodesSchemas } from "@/modules/episodes/openapi";
import { evaluationsPaths, evaluationsSchemas } from "@/modules/evaluations/openapi";
import { graphPaths } from "@/modules/graph/openapi";
import { memoriesPaths, memoriesSchemas } from "@/modules/memories/openapi";
import { operationsPaths, operationsSchemas } from "@/modules/operations/openapi";
import { LORE_API_VERSION } from "@/modules/operations/service";
import { portabilityPaths, portabilitySchemas } from "@/modules/portability/openapi";
import { proposalsPaths, proposalsSchemas } from "@/modules/proposals/openapi";
import { workspacesPaths, workspacesSchemas } from "@/modules/workspaces/openapi";
import { actorSecurity } from "./shared";

export function loreOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.1",
    info: {
      title: "Lore Portable Core",
      version: LORE_API_VERSION,
      description:
        "RLS-enforced Memory storage, retrieval, portability, and revision-bound Code Evidence. Human authentication is deployment-selected; Agent credentials use Lore bearer tokens.",
    },
    servers: [{ url: "/" }],
    security: actorSecurity,
    paths: {
      ...workspacesPaths,
      ...memoriesPaths,
      ...codePaths,
      ...contextPaths,
      ...episodesPaths,
      ...proposalsPaths,
      ...graphPaths,
      ...agentsPaths,
      ...evaluationsPaths,
      ...portabilityPaths,
      ...operationsPaths,
    },
    components: {
      schemas: {
        ...operationsSchemas,
        ...memoriesSchemas,
        ...episodesSchemas,
        ...proposalsSchemas,
        ...contextSchemas,
        ...codeSchemas,
        ...workspacesSchemas,
        ...agentsSchemas,
        ...evaluationsSchemas,
        ...portabilitySchemas,
      },
      responses: {
        Error: {
          description: "Stable Lore error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      securitySchemes: {
        agentBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "lore_agent_<64 lowercase hex characters>",
        },
        basicAuth: { type: "http", scheme: "basic" },
        cloudflareAccessHeader: {
          type: "apiKey",
          in: "header",
          name: "cf-access-jwt-assertion",
        },
        cloudflareAccessCookie: { type: "apiKey", in: "cookie", name: "CF_Authorization" },
      },
    },
  };
}
