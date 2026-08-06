import { createEvaluationSuiteHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeMemoryModuleOptions } from "@/lib/runtime/embedding";

export async function GET(request: Request) {
  return createEvaluationSuiteHandlers(await getRuntimeDatabase(), {
    memoryOptions: getRuntimeMemoryModuleOptions(),
  }).GET(request);
}

export async function POST(request: Request) {
  return createEvaluationSuiteHandlers(await getRuntimeDatabase(), {
    memoryOptions: getRuntimeMemoryModuleOptions(),
  }).POST(request);
}
