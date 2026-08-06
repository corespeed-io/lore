import { createEvaluationRunByIdHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeMemoryModuleOptions } from "@/lib/runtime/embedding";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return createEvaluationRunByIdHandlers(await getRuntimeDatabase(), {
    memoryOptions: getRuntimeMemoryModuleOptions(),
  }).GET(request, (await context.params).id);
}
