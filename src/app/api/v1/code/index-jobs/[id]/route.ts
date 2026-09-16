import { createCodeIndexJobByIdHandlers } from "@/modules/code/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request, context: RouteContext<"/api/v1/code/index-jobs/[id]">) {
  const { id } = await context.params;
  return createCodeIndexJobByIdHandlers(await getRuntimeDatabase()).GET(request, id);
}
