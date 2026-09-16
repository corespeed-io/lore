import { createAgentCredentialHandlers } from "@/modules/agents/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return createAgentCredentialHandlers(await getRuntimeDatabase()).GET(
    request,
    (await context.params).id,
  );
}

export async function POST(request: Request, context: RouteContext) {
  return createAgentCredentialHandlers(await getRuntimeDatabase()).POST(
    request,
    (await context.params).id,
  );
}
