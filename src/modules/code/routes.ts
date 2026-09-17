import { Hono } from "hono";
import { createCodeIndexQueueModule } from "@/modules/code/indexing/queue";
import {
  createCodeIndexReadModule,
  MAXIMUM_CODE_INDEX_JOB_LIST,
} from "@/modules/code/indexing/read";
import type { ApiEnv } from "@/server/api/dependencies";
import { BadRequestError, jsonObject } from "@/server/api/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import type { CodeEvidenceRelationship } from "./evidence";
import { createCodeEvidenceModule } from "./evidence";
import type { CodeDependencyDirection } from "./graph";
import { createCodeDependencyGraphModule } from "./graph";

function requiredQuery(url: URL, name: string, maximumLength: number): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value || value.length > maximumLength) {
    throw new BadRequestError(`${name} is required`);
  }
  return value;
}

function optionalLimit(url: URL, maximum = 100): number | undefined {
  const value = url.searchParams.get("limit");
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new BadRequestError(`limit must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

function dependencyDirection(url: URL): CodeDependencyDirection {
  const value = requiredQuery(url, "direction", 16);
  if (value !== "callers" && value !== "callees") {
    throw new BadRequestError("direction must be callers or callees");
  }
  return value;
}

function requiredBodyString(
  body: Record<string, unknown>,
  name: string,
  maximumLength: number,
): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new BadRequestError(`${name} is required`);
  }
  return value.trim();
}

export const code = new Hono<ApiEnv>()
  .get("/search", async (c) => {
    const code = createCodeIndexReadModule(await c.var.database());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const url = new URL(request.url);
    const pathPrefix = url.searchParams.get("path_prefix")?.trim() || undefined;
    const results = await observeOperation("code-index.search", () =>
      code.search(actor, {
        repositoryKey: requiredQuery(url, "repository_key", 512),
        commitOid: requiredQuery(url, "commit_oid", 64),
        query: requiredQuery(url, "q", 2_000),
        limit: optionalLimit(url),
        pathPrefix,
      }),
    );
    return c.json(results);
  })
  .get("/dependencies", async (c) => {
    const graph = createCodeDependencyGraphModule(await c.var.database());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol") ?? undefined;
    const path = url.searchParams.get("path") ?? undefined;
    const result = await observeOperation("code-index.dependencies", () =>
      graph.query(actor, {
        repositoryKey: requiredQuery(url, "repository_key", 512),
        commitOid: requiredQuery(url, "commit_oid", 64),
        direction: dependencyDirection(url),
        symbol,
        path,
        limit: optionalLimit(url, 200),
      }),
    );
    return c.json(result);
  })
  .get("/index-jobs", async (c) => {
    const code = createCodeIndexReadModule(await c.var.database());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const url = new URL(request.url);
    const jobs = await observeOperation("code-index.jobs", () =>
      code.listIndexJobs(actor, { limit: optionalLimit(url, MAXIMUM_CODE_INDEX_JOB_LIST) }),
    );
    return c.json(jobs);
  })
  .post("/index-jobs", async (c) => {
    const queue = createCodeIndexQueueModule(await c.var.database(), c.var.codeRepositories());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const body = await jsonObject(request);
    const sourceRef = body.sourceRef;
    if (sourceRef !== undefined && typeof sourceRef !== "string") {
      throw new BadRequestError("sourceRef must be a string");
    }
    const job = await observeOperation("code-index.enqueue", () =>
      queue.enqueue(actor, {
        repositoryKey: requiredBodyString(body, "repositoryKey", 512),
        commitOid: requiredBodyString(body, "commitOid", 64),
        ...(typeof sourceRef === "string" ? { sourceRef } : {}),
      }),
    );
    return c.json(job, 202);
  })
  .get("/index-jobs/:id", async (c) => {
    const code = createCodeIndexReadModule(await c.var.database());
    const id = c.req.param("id");
    const actor = await c.var.resolveActor();
    const job = await observeOperation("code-index.job", () =>
      code.getIndexJob(actor, { jobId: id }),
    );
    return c.json(job);
  });

export const memoryCodeEvidence = new Hono<ApiEnv>()
  .get("/:id/code-evidence", async (c) => {
    const evidence = createCodeEvidenceModule(await c.var.database());
    const memoryId = c.req.param("id");
    const actor = await c.var.resolveActor();
    const result = await observeOperation("code-evidence.list", () =>
      evidence.list(actor, { memoryId }),
    );
    return c.json(result);
  })
  .post("/:id/code-evidence", async (c) => {
    const evidence = createCodeEvidenceModule(await c.var.database());
    const request = c.req.raw;
    const memoryId = c.req.param("id");
    const actor = await c.var.resolveActor();
    const body = await jsonObject(request);
    const relationship = requiredBodyString(body, "relationship", 32) as CodeEvidenceRelationship;
    const result = await observeOperation("code-evidence.cite", () =>
      evidence.cite(actor, {
        memoryId,
        artifactId: requiredBodyString(body, "artifactId", 36),
        relationship,
      }),
    );
    return c.json(result, 201);
  });

export const codeEvidence = new Hono<ApiEnv>().post("/:id/revalidate", async (c) => {
  const evidence = createCodeEvidenceModule(await c.var.database());
  const request = c.req.raw;
  const evidenceId = c.req.param("id");
  const actor = await c.var.resolveActor();
  const body = await jsonObject(request);
  const result = await observeOperation("code-evidence.revalidate", () =>
    evidence.revalidate(actor, {
      evidenceId,
      repositoryKey: requiredBodyString(body, "repositoryKey", 512),
      commitOid: requiredBodyString(body, "commitOid", 64),
    }),
  );
  return c.json(result);
});
