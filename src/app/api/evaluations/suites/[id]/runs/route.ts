import { createEvaluationRunHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return createEvaluationRunHandlers(await getRuntimeDatabase()).POST(
    request,
    (await context.params).id,
  );
}
