import type { PostgresDatabase } from "@corespeed/lore-core";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import {
  BadRequestError,
  jsonObject,
  requiredString,
  requireHumanActor,
  uuidArray,
  uuidString,
} from "@/server/http/input";
import type { EvaluationCaseInput, EvaluationModuleOptions } from "./service";
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

export function createEvaluationSuiteHandlers(
  database: PostgresDatabase,
  options: EvaluationModuleOptions = {},
) {
  const evaluations = createEvaluationModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await evaluations.listSuites(actor));
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
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
        return Response.json(suite, { status: 201 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createEvaluationRunHandlers(
  database: PostgresDatabase,
  options: EvaluationModuleOptions = {},
) {
  const evaluations = createEvaluationModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async POST(request: Request, suiteId: string): Promise<Response> {
      try {
        const normalizedSuiteId = uuidString(suiteId, "suiteId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await evaluations.runSuite(actor, normalizedSuiteId), { status: 201 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createEvaluationRunByIdHandlers(
  database: PostgresDatabase,
  options: EvaluationModuleOptions = {},
) {
  const evaluations = createEvaluationModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, runId: string): Promise<Response> {
      try {
        const normalizedRunId = uuidString(runId, "runId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const run = await evaluations.getRun(actor, normalizedRunId);
        return run
          ? Response.json(run)
          : Response.json(
              { code: "not_found", error: "Evaluation run not found" },
              { status: 404 },
            );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
