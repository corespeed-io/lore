import { createEvaluationSuiteHandlers } from "@/modules/evaluations/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createEvaluationSuiteHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createEvaluationSuiteHandlers(await getRuntimeDatabase()).POST(request);
}
