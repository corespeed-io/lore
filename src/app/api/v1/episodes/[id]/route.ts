import { createEpisodeByIdHandlers } from "@/modules/episodes/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return createEpisodeByIdHandlers(await getRuntimeDatabase()).GET(
    request,
    (await context.params).id,
  );
}

export async function DELETE(request: Request, context: RouteContext) {
  return createEpisodeByIdHandlers(await getRuntimeDatabase()).DELETE(
    request,
    (await context.params).id,
  );
}
