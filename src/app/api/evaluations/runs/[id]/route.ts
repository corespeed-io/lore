import { createEvaluationRunByIdHandlers } from "@/modules/evaluations/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return createEvaluationRunByIdHandlers(await getRuntimeDatabase()).GET(
    request,
    (await context.params).id,
  );
}
