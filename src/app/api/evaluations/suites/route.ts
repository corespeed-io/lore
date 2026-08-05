import { createEvaluationSuiteHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createEvaluationSuiteHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createEvaluationSuiteHandlers(await getRuntimeDatabase()).POST(request);
}
