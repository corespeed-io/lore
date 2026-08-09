import { createAgentCredentialHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

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
