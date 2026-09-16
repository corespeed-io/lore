import { createEvaluationRunHandlers } from "@/modules/evaluations/http";
import { getRuntimeDatabase } from "@/server/database/runtime";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/embedding/runtime";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return createEvaluationRunHandlers(await getRuntimeDatabase(), {
    memoryOptions: await getRuntimeMemoryModuleOptions(),
  }).POST(request, (await context.params).id);
}
