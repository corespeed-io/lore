import { createEvaluationRunHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeMemoryModuleOptions } from "@/lib/runtime/embedding";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return createEvaluationRunHandlers(await getRuntimeDatabase(), {
    memoryOptions: await getRuntimeMemoryModuleOptions(),
  }).POST(request, (await context.params).id);
}
