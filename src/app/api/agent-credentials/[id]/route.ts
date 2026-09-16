import { createAgentCredentialByIdHandlers } from "@/modules/agents/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  return createAgentCredentialByIdHandlers(await getRuntimeDatabase()).DELETE(
    request,
    (await context.params).id,
  );
}
