import { createAgentCredentialByIdHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  return createAgentCredentialByIdHandlers(await getRuntimeDatabase()).DELETE(
    request,
    (await context.params).id,
  );
}
