import { createAgentGrantHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PUT(request: Request, context: RouteContext) {
  return createAgentGrantHandlers(await getRuntimeDatabase()).PUT(
    request,
    (await context.params).id,
  );
}

export async function DELETE(request: Request, context: RouteContext) {
  return createAgentGrantHandlers(await getRuntimeDatabase()).DELETE(
    request,
    (await context.params).id,
  );
}
