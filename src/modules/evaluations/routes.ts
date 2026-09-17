import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import {
  BadRequestError,
  jsonObject,
  requiredString,
  requireHumanActor,
  uuidArray,
  uuidString,
} from "@/server/api/input";
import type { EvaluationCaseInput } from "./service";
import { createEvaluationModule } from "./service";

function evaluationCases(value: unknown): EvaluationCaseInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError("cases must be a non-empty array");
  }
  if (value.length > 1_000) throw new BadRequestError("cases exceeds 1000 items");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestError(`cases[${index}] must be an object`);
    }
    const evaluationCase = item as Record<string, unknown>;
    const requestedLimit = evaluationCase.limit === undefined ? 10 : Number(evaluationCase.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      throw new BadRequestError(`cases[${index}].limit must be an integer from 1 to 100`);
    }
    return {
      query: requiredString(evaluationCase.query, `cases[${index}].query`, 10_000),
      expectedMemoryIds: uuidArray(
        evaluationCase.expectedMemoryIds,
        `cases[${index}].expectedMemoryIds`,
        false,
      ),
      forbiddenMemoryIds:
        evaluationCase.forbiddenMemoryIds === undefined
          ? []
          : uuidArray(
              evaluationCase.forbiddenMemoryIds,
              `cases[${index}].forbiddenMemoryIds`,
              true,
            ),
      limit: requestedLimit,
    };
  });
}

export const evaluations = new Hono<ApiEnv>()
  .get("/suites", async (c) => {
    const evaluations = createEvaluationModule(await c.var.database());
    const actor = requireHumanActor(await c.var.resolveActor());
    return c.json(await evaluations.listSuites(actor));
  })
  .post("/suites", async (c) => {
    const evaluations = createEvaluationModule(await c.var.database());
    const request = c.req.raw;
    const actor = requireHumanActor(await c.var.resolveActor());
    const body = await jsonObject(request);
    const requestedVersion = body.version === undefined ? 1 : Number(body.version);
    if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
      throw new BadRequestError("version must be a positive integer");
    }
    const suite = await evaluations.createSuite(actor, {
      name: requiredString(body.name, "name", 120),
      version: requestedVersion,
      description:
        body.description === undefined
          ? undefined
          : requiredString(body.description, "description", 10_000),
      cases: evaluationCases(body.cases),
    });
    return c.json(suite, 201);
  })
  .post("/suites/:id/runs", async (c) => {
    const evaluations = createEvaluationModule(await c.var.database(), {
      memoryOptions: c.var.memoryOptions(),
    });
    const suiteId = c.req.param("id");
    const normalizedSuiteId = uuidString(suiteId, "suiteId");
    const actor = requireHumanActor(await c.var.resolveActor());
    return c.json(await evaluations.runSuite(actor, normalizedSuiteId), 201);
  })
  .get("/runs/:id", async (c) => {
    const evaluations = createEvaluationModule(await c.var.database());
    const runId = c.req.param("id");
    const normalizedRunId = uuidString(runId, "runId");
    const actor = requireHumanActor(await c.var.resolveActor());
    const run = await evaluations.getRun(actor, normalizedRunId);
    return run
      ? c.json(run)
      : c.json({ code: "not_found", error: "Evaluation run not found" }, 404);
  });
