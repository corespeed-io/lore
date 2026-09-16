import { createMemoryCodeEvidenceHandlers } from "@/modules/code/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/memories/[id]/code-evidence">,
) {
  const { id } = await context.params;
  return createMemoryCodeEvidenceHandlers(await getRuntimeDatabase()).GET(request, id);
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/memories/[id]/code-evidence">,
) {
  const { id } = await context.params;
  return createMemoryCodeEvidenceHandlers(await getRuntimeDatabase()).POST(request, id);
}
