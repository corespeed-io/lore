import { createEvaluationRunByIdHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return createEvaluationRunByIdHandlers(await getRuntimeDatabase()).GET(
    request,
    (await context.params).id,
  );
}
