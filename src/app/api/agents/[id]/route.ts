import { createAgentByIdHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  return createAgentByIdHandlers(await getRuntimeDatabase()).PATCH(
    request,
    (await context.params).id,
  );
}

export async function DELETE(request: Request, context: RouteContext) {
  return createAgentByIdHandlers(await getRuntimeDatabase()).DELETE(
    request,
    (await context.params).id,
  );
}
