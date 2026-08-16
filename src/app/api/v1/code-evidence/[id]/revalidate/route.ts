import { createCodeEvidenceByIdHandlers } from "@/lib/code-http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/code-evidence/[id]/revalidate">,
) {
  const { id } = await context.params;
  return createCodeEvidenceByIdHandlers(await getRuntimeDatabase()).POST(request, id);
}
