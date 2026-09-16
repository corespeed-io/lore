import { createMemoryProposalReviewHandlers } from "@/modules/proposals/http";
import { getRuntimeDatabase } from "@/server/database/runtime";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/embedding/runtime";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return createMemoryProposalReviewHandlers(
    await getRuntimeDatabase(),
    await getRuntimeMemoryModuleOptions({ maintenanceNotifications: true }),
  ).POST(request, (await context.params).id);
}
