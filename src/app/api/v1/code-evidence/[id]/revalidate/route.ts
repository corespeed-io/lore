import { createCodeEvidenceByIdHandlers } from "@/modules/code/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/code-evidence/[id]/revalidate">,
) {
  const { id } = await context.params;
  return createCodeEvidenceByIdHandlers(await getRuntimeDatabase()).POST(request, id);
}
